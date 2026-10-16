#!/usr/bin/env python3
"""CLI bridge exposing spotifyscraper's anonymous (no-login) capabilities as
JSON-over-stdout, one subprocess per call. Spotify's official Web API (OAuth
and Client Credentials alike) is blocked entirely for this app's registered
credentials since Feb 2026 unless the app owner has Premium -- see
src/core/clients/spotify-scraper.ts for the TypeScript side of this contract
and why this exists at all. spotifyscraper bootstraps its own anonymous token
from Spotify's public web-player infra, independent of any app we register.

Deliberately does NOT expose get_user() -- listing a username's playlists
requires a real logged-in sp_dc session cookie, which was evaluated and
rejected (bigger security exposure than the OAuth this replaces). Only
public, no-login endpoints are wired up here: search, a single playlist's
tracks by URL/ID, artist info, and discography.
"""
import argparse
import json
import sys

from spotify_scraper import SpotifyClient
from spotify_scraper.errors import NotFoundError


def _track_dict(track):
    return {
        "name": track.name,
        "artists": [a.name for a in track.artists],
        "uri": track.uri,
        # Raw stream count, not a 0-100 popularity score -- the scraper's
        # public Track model doesn't expose the official API's "popularity"
        # field at all. Callers treat this as a relative-ranking signal only.
        "playCount": track.play_count,
    }


def _image_url(images, prefer_width=300):
    """Closest image to prefer_width from a spotifyscraper images tuple, or
    the first one when widths are unknown (playlist covers carry none)."""
    if not images:
        return None
    sized = [i for i in images if i.width]
    if not sized:
        return images[0].url
    return min(sized, key=lambda i: abs(i.width - prefer_width)).url


def _playlist_track_dict(playlist_track):
    track = playlist_track.track
    if track is None or not track.artists:
        return None
    return {
        "artistName": track.artists[0].name,
        "trackName": track.name,
        "albumTitle": track.album.name if track.album else None,
        "coverUrl": _image_url(track.album.images) if track.album else None,
    }


def cmd_search(client, args):
    types = [t.strip() for t in args.types.split(",") if t.strip()]
    results = client.search(args.query, types=types, limit=args.limit)
    return {
        "tracks": [_track_dict(t) for t in results.tracks],
        "artists": [{"name": a.name, "id": a.id} for a in results.artists],
    }


def cmd_playlist(client, args):
    playlist = client.get_playlist(args.value, max_tracks=args.max_tracks)
    tracks = [
        d for d in (_playlist_track_dict(t) for t in playlist.tracks) if d is not None
    ]
    return {"name": playlist.name, "imageUrl": _image_url(playlist.images), "tracks": tracks}


def cmd_artist(client, args):
    artist = client.get_artist(args.value)
    return {
        "name": artist.name,
        "id": artist.id,
        # No genre tags in the scraped Artist model (Spotify dropped this
        # from public artist data); monthlyListeners is the closest available
        # relative-popularity proxy.
        "monthlyListeners": artist.monthly_listeners,
    }


def cmd_discography(client, args):
    # AlbumRef only carries id/name/images -- no release_date or album_type
    # in the scraped model, so callers can't sort by recency or filter out
    # singles/compilations the way the old official-API version could.
    # Returned in whatever order Spotify's own discography page uses.
    releases = client.get_discography(args.value, max_releases=args.limit)
    return {"releases": [{"id": r.id, "title": r.name} for r in releases]}


def cmd_album_top_track(client, args):
    # Returns every track on the album, ranked by play count (highest
    # first) -- callers use tracks[0] for a single "best track" pick (the
    # embedded player) and the full list for a per-album top-tracks
    # display, so both always agree on ranking/scope instead of drifting
    # like the old Deezer-artist-wide-chart vs. Spotify-single-track split.
    #
    # play_count is null on every *search* result (confirmed live) -- it's
    # only populated on a full album fetch's track list. So this can't just
    # search types=track and sort by popularity like the other commands; it
    # has to search types=album to resolve the album's id, then fetch that
    # album in full to get real per-track play counts to rank by.
    #
    # Spotify's search never returns zero results for types=album -- garbage
    # input still comes back with *something*, fuzzy-matched (confirmed
    # live: searching a nonsense artist/album pair still returned an
    # unrelated album). Search-result albums don't carry an artist field to
    # filter on up front, so every candidate is fetched in full and the
    # first one whose artists actually include the requested artist name
    # wins -- an album-name match alone isn't enough to trust the pick.
    results = client.search(f"{args.artist} {args.album}", types=["album"], limit=5)
    if not results.albums:
        raise NotFoundError(f"No album match for '{args.artist} - {args.album}'")

    requested_artist = args.artist.strip().lower()
    requested_album = args.album.strip().lower()
    candidates = sorted(
        results.albums,
        key=lambda a: a.name.strip().lower() != requested_album,
    )

    full = None
    for candidate in candidates:
        fetched = client.get_album(candidate.id)
        if any(requested_artist == ar.name.strip().lower() for ar in fetched.artists):
            full = fetched
            break

    if full is None:
        raise NotFoundError(f"No album match for '{args.artist} - {args.album}'")
    if not full.tracks:
        raise NotFoundError(f"Album '{full.name}' has no tracks")

    ranked = sorted(full.tracks, key=lambda t: t.play_count or 0, reverse=True)
    return {
        "tracks": [
            {"name": t.name, "uri": t.uri, "playCount": t.play_count} for t in ranked
        ]
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_search = sub.add_parser("search")
    p_search.add_argument("query")
    p_search.add_argument("--types", default="track")
    p_search.add_argument("--limit", type=int, default=10)

    p_playlist = sub.add_parser("playlist")
    p_playlist.add_argument("value")
    p_playlist.add_argument("--max-tracks", type=int, default=500, dest="max_tracks")

    p_artist = sub.add_parser("artist")
    p_artist.add_argument("value")

    p_discography = sub.add_parser("discography")
    p_discography.add_argument("value")
    p_discography.add_argument("--limit", type=int, default=50)

    p_album_top_track = sub.add_parser("album-top-track")
    p_album_top_track.add_argument("artist")
    p_album_top_track.add_argument("album")

    args = parser.parse_args()
    client = SpotifyClient()
    try:
        if args.command == "search":
            result = cmd_search(client, args)
        elif args.command == "playlist":
            result = cmd_playlist(client, args)
        elif args.command == "artist":
            result = cmd_artist(client, args)
        elif args.command == "discography":
            result = cmd_discography(client, args)
        elif args.command == "album-top-track":
            result = cmd_album_top_track(client, args)
        else:
            raise ValueError(f"unknown command {args.command}")
    except NotFoundError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001 -- broad by design, this is a CLI boundary
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()

    print(json.dumps(result))


if __name__ == "__main__":
    main()
