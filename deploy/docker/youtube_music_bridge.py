#!/usr/bin/env python3
"""CLI bridge exposing ytmusicapi's anonymous (no-login) playlist read as
JSON-over-stdout, one subprocess per call -- same contract as
spotify_bridge.py (see src/core/clients/spotify.ts for why that pattern
exists). YouTube Music has no simple public REST endpoint like Deezer's, but
ytmusicapi can browse a playlist anonymously as long as it's Public, so this
only wires up that one read-only, no-login capability: fetching a public
playlist's tracks by URL/ID.
"""
import argparse
import json
import sys

from ytmusicapi import YTMusic
from ytmusicapi.exceptions import YTMusicServerError


class PlaylistNotFoundError(Exception):
    pass


def _thumbnail_url(thumbnails):
    """Largest of ytmusicapi's thumbnails list ([{url, width, height}, ...])."""
    if not thumbnails:
        return None
    return max(thumbnails, key=lambda t: t.get("width") or 0).get("url")


def _parse_artist_track_title(title):
    """A fan-uploaded video's title conventionally reads "Artist - Track"
    (confirmed live against a real playlist, e.g. "Homegrown - Surfer
    Girl"). Splits on the first ' - ' only, since that's the separator this
    convention uses; a title with no ' - ' at all can't be parsed this way,
    so callers keep whatever they already had."""
    if " - " not in title:
        return None
    artist, track = title.split(" - ", 1)
    artist, track = artist.strip(), track.strip()
    if not artist or not track:
        return None
    return artist, track


def cmd_playlist(client, args):
    # get_playlist's own `limit` only controls whether continuation pages
    # beyond the first are fetched -- it always returns the first page (100
    # tracks) in full even when limit is smaller, so the cap has to be
    # re-applied here to actually bound the result (confirmed live: limit=5
    # against a 100+ track playlist still returned all 100).
    #
    # A missing/private/unlisted playlist doesn't raise a dedicated
    # ytmusicapi exception -- it fails as a raw KeyError deep in response
    # parsing (confirmed live against a nonexistent ID), so that's caught
    # here and turned into a clean, user-facing message instead of leaking
    # the internal response-traversal error.
    try:
        playlist = client.get_playlist(args.value, limit=args.max_tracks)
    except KeyError as exc:
        raise PlaylistNotFoundError(
            "Playlist not found -- make sure it's set to Public in YouTube Music."
        ) from exc
    tracks = []
    for t in playlist.get("tracks", []):
        if len(tracks) >= args.max_tracks:
            break
        artists = t.get("artists") or []
        if not artists or not t.get("videoId"):
            continue
        album = t.get("album")
        artist_name = artists[0]["name"]
        track_name = t["title"]
        # A fan-uploaded video's reported "artist" is really the uploader's
        # channel name, not a musician (e.g. "SkankinLozer") -- only a
        # canonical track (videoType MUSIC_VIDEO_TYPE_ATV) has a real artist
        # in that field. For anything else, the actual artist/track is
        # usually baked into the title instead; parse it out when possible
        # rather than importing the channel name as if it were the artist.
        if t.get("videoType") != "MUSIC_VIDEO_TYPE_ATV":
            parsed = _parse_artist_track_title(track_name)
            if parsed:
                artist_name, track_name = parsed
        tracks.append(
            {
                "artistName": artist_name,
                "trackName": track_name,
                "albumTitle": album["name"] if album else None,
                "coverUrl": _thumbnail_url(t.get("thumbnails")),
            }
        )
    return {
        "name": playlist.get("title"),
        "imageUrl": _thumbnail_url(playlist.get("thumbnails")),
        "tracks": tracks,
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_playlist = sub.add_parser("playlist")
    p_playlist.add_argument("value")
    p_playlist.add_argument("--max-tracks", type=int, default=500, dest="max_tracks")

    args = parser.parse_args()
    client = YTMusic()
    try:
        if args.command == "playlist":
            result = cmd_playlist(client, args)
        else:
            raise ValueError(f"unknown command {args.command}")
    except (YTMusicServerError, PlaylistNotFoundError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001 -- broad by design, this is a CLI boundary
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
