export type SeasonalSong = { artist: string; title: string; anyArtist?: boolean }

export type SeasonalPreset = {
  key: string
  // Display name (settings toggle list, playlist name).
  label: string
  // Musical-style words, matched against an artist's genre tags to softly
  // boost thematically-tagged artists during selection (see
  // strategies/seasonal.ts's artistMatchesKeywords). Deliberately a boost,
  // never a hard filter -- a genre-only filter would exclude a mainstream
  // artist who isn't genre-tagged for the occasion at all (Mariah Carey has
  // no "christmas" genre tag, but has the most famous Christmas song there
  // is), which is exactly the actual theming an iconic-holiday preset needs.
  genreKeywords: string[]
  // Words that actually show up in the TITLES of real songs about this
  // theme -- distinct from genreKeywords on purpose: a genre-style word like
  // "gothic" or "industrial" almost never appears in a track title, so using
  // it for title matching silently matches nothing and the resolver falls
  // back to an artist's generic top tracks (see track-resolver.ts's
  // prioritizeByTitle / generator.ts's includeTitleKeywords) -- which is
  // what made Halloween in particular come out with no Halloween songs.
  titleKeywords: string[]
  // One-line description of the theme, handed to the AI when it's asked to
  // name songs from the listener's library that fit (see
  // seasonal-generator.ts). Written as what makes a song belong, not a mood.
  theme: string
  // Well-known songs for the season, checked against the library by title
  // on every generation so the playlist has its classics even without an AI
  // provider. `anyArtist` marks standards whose covers count too (carols,
  // "White Christmas"); everything else must match the listed artist.
  songs: SeasonalSong[]
  // Deezer playlist searches whose top (preferably editor-curated) results
  // are mined for this season's songs -- see seasonal-online.ts. Each
  // result's title must still contain `onlineTitleWord` to count.
  onlineQueries: string[]
  onlineTitleWord: string
  // A song mined from those playlists only counts once it shows up in at
  // least this many of them -- "Halloween Party" lists pad with generic pop
  // ("Toxic"), and summer lists with each decade's hits; a song several
  // independent seasonal lists agree on is the real seasonal signal.
  // Christmas lists are reliably on-theme, so one is enough there.
  onlineMinPlaylists: number
  // 1-indexed months/days, inclusive. startMonth/day may be "later" than
  // endMonth/day (e.g. Dec 15 -> Jan 5) -- isWithinSeasonalWindow wraps.
  window: { startMonth: number; startDay: number; endMonth: number; endDay: number }
  // Strongly-iconic holidays (Halloween, Christmas) weight artist selection
  // more heavily toward genre-tagged matches. Vaguer presets (Summer) with
  // no fixed genre identity instead blend a lighter boost with the
  // listener's own track-level taste profile (see strategies/seasonal.ts).
  blendWithTaste: boolean
}

// Small built-in list, easy to extend later -- each preset needs a
// genre/mood keyword set (matched the same way mood-mix's MOOD_ALIASES are)
// for artist-level boosting, a separate title-keyword set for track-level
// matching, and a default calendar window.
export const SEASONAL_PRESETS: SeasonalPreset[] = [
  {
    key: 'halloween',
    label: 'Halloween',
    theme:
      'Halloween: songs about monsters, ghosts, witches, vampires, zombies, the devil, horror, the macabre, or spooky nights -- plus the classic Halloween party songs and movie themes',
    genreKeywords: [
      'halloween',
      'horror',
      'horrorcore',
      'horror punk',
      'gothic',
      'goth',
      'dark ambient',
      'deathrock',
      'witch house',
      'darkwave',
      'shock rock',
    ],
    titleKeywords: [
      'halloween',
      'monster',
      'monsters',
      'zombie',
      'zombies',
      'ghost',
      'ghosts',
      'ghoul',
      'ghouls',
      'witch',
      'witches',
      'witchcraft',
      'vampire',
      'vampires',
      'haunted',
      'haunting',
      'skeleton',
      'skeletons',
      'werewolf',
      'werewolves',
      'graveyard',
      'cemetery',
      'nightmare',
      'scary',
      'spooky',
      'thriller',
      'frankenstein',
      'dracula',
      'possessed',
      'creepy',
      'boogeyman',
      'bogeyman',
      'pumpkin',
      'full moon',
      'black magic',
      'voodoo',
      'exorcist',
      'poltergeist',
      'undead',
    ],
    songs: [
      { artist: 'Michael Jackson', title: 'Thriller' },
      { artist: 'Bobby "Boris" Pickett', title: 'Monster Mash', anyArtist: true },
      { artist: 'Ray Parker Jr.', title: 'Ghostbusters' },
      { artist: 'Rockwell', title: "Somebody's Watching Me" },
      { artist: 'Blue \u00d6yster Cult', title: "(Don't Fear) The Reaper" },
      { artist: 'Warren Zevon', title: 'Werewolves of London' },
      { artist: 'Creedence Clearwater Revival', title: 'Bad Moon Rising' },
      { artist: 'Talking Heads', title: 'Psycho Killer' },
      { artist: 'Donovan', title: 'Season of the Witch' },
      { artist: "Screamin' Jay Hawkins", title: 'I Put a Spell on You', anyArtist: true },
      { artist: 'Oingo Boingo', title: "Dead Man's Party" },
      { artist: 'Ozzy Osbourne', title: 'Bark at the Moon' },
      { artist: 'Rihanna', title: 'Disturbia' },
      { artist: 'Eagles', title: 'Witchy Woman' },
      { artist: 'The Cranberries', title: 'Zombie' },
      { artist: 'Siouxsie and the Banshees', title: 'Spellbound' },
      { artist: 'Bauhaus', title: "Bela Lugosi's Dead" },
      { artist: 'The Specials', title: 'Ghost Town' },
      { artist: 'Santana', title: 'Black Magic Woman' },
      { artist: 'Fleetwood Mac', title: 'Black Magic Woman' },
      { artist: 'Duran Duran', title: 'Hungry Like the Wolf' },
      { artist: 'Yeah Yeah Yeahs', title: 'Heads Will Roll' },
      { artist: 'Marilyn Manson', title: 'This Is Halloween' },
      { artist: 'Danny Elfman', title: 'This Is Halloween', anyArtist: true },
      { artist: "Richard O'Brien", title: 'Time Warp', anyArtist: true },
      { artist: 'The Misfits', title: 'Halloween' },
      { artist: 'Misfits', title: 'Halloween' },
      { artist: 'Alice Cooper', title: 'Feed My Frankenstein' },
      { artist: 'Stevie Wonder', title: 'Superstition' },
      { artist: 'Kanye West', title: 'Monster' },
      { artist: 'Eminem', title: 'Monster' },
      { artist: 'The Rolling Stones', title: 'Sympathy for the Devil' },
      { artist: 'AC/DC', title: 'Highway to Hell' },
      { artist: 'Metallica', title: 'Enter Sandman' },
      { artist: 'Iron Maiden', title: 'Fear of the Dark' },
      { artist: 'Iron Maiden', title: 'The Number of the Beast' },
      { artist: 'Black Sabbath', title: 'Black Sabbath' },
      { artist: 'The Cure', title: 'Lullaby' },
      { artist: 'Concrete Blonde', title: 'Bloodletting (The Vampire Song)' },
      { artist: 'Rob Zombie', title: 'Dragula' },
      { artist: 'White Zombie', title: "Thunder Kiss '65" },
      { artist: 'Kate Bush', title: 'Hounds of Love' },
      { artist: 'The Doors', title: 'People Are Strange' },
      { artist: 'Lady Gaga', title: 'Bloody Mary' },
      { artist: 'Billie Eilish', title: 'bury a friend' },
      { artist: 'Halsey', title: 'Castle' },
      { artist: 'Imagine Dragons', title: 'Demons' },
      { artist: 'Michael Jackson', title: 'Ghosts' },
      { artist: 'Ray Parker, Jr.', title: 'Ghostbusters' },
      { artist: 'Mike Oldfield', title: 'Tubular Bells' },
      { artist: 'Camille Saint-Sa\u00ebns', title: 'Danse Macabre', anyArtist: true },
      { artist: 'Edvard Grieg', title: 'In the Hall of the Mountain King', anyArtist: true },
      { artist: 'Modest Mussorgsky', title: 'Night on Bald Mountain', anyArtist: true },
      { artist: 'John Carpenter', title: 'Halloween Theme', anyArtist: true },
      { artist: 'Vic Mizzy', title: 'The Addams Family Theme', anyArtist: true },
      { artist: 'Jack Marshall', title: 'The Munsters Theme', anyArtist: true },
    ],
    onlineQueries: ['halloween party', 'halloween hits', 'vintage halloween', 'halloween songs'],
    onlineTitleWord: 'halloween',
    onlineMinPlaylists: 2,
    window: { startMonth: 10, startDay: 1, endMonth: 10, endDay: 31 },
    blendWithTaste: false,
  },
  {
    key: 'christmas',
    label: 'Christmas',
    theme:
      'Christmas and the winter holidays: Christmas songs, carols, Santa, snow, sleigh rides, and holiday standards',
    genreKeywords: ['christmas', 'holiday', 'xmas', 'carol'],
    titleKeywords: [
      'christmas',
      'christmastime',
      'xmas',
      'santa',
      'jingle',
      'sleigh',
      'mistletoe',
      'reindeer',
      'rudolph',
      'snowman',
      'frosty',
      'silent night',
      'holy night',
      'holly jolly',
      'noel',
      'yuletide',
      'winter wonderland',
      'deck the halls',
      'let it snow',
      'navidad',
      'little drummer boy',
      'away in a manger',
      'o come all ye faithful',
      'hark the herald',
      'joy to the world',
      'carol of the bells',
      'chestnuts',
      'nutcracker',
      'grinch',
    ],
    songs: [
      { artist: 'Mariah Carey', title: 'All I Want for Christmas Is You' },
      { artist: 'Wham!', title: 'Last Christmas', anyArtist: true },
      { artist: 'Brenda Lee', title: "Rockin' Around the Christmas Tree", anyArtist: true },
      { artist: 'Bobby Helms', title: 'Jingle Bell Rock', anyArtist: true },
      { artist: 'Jos\u00e9 Feliciano', title: 'Feliz Navidad', anyArtist: true },
      { artist: 'Bing Crosby', title: 'White Christmas', anyArtist: true },
      { artist: 'Nat King Cole', title: 'The Christmas Song', anyArtist: true },
      {
        artist: 'Andy Williams',
        title: "It's the Most Wonderful Time of the Year",
        anyArtist: true,
      },
      { artist: 'Burl Ives', title: 'A Holly Jolly Christmas', anyArtist: true },
      { artist: 'Dean Martin', title: 'Let It Snow! Let It Snow! Let It Snow!', anyArtist: true },
      { artist: 'Frank Sinatra', title: 'Let It Snow', anyArtist: true },
      {
        artist: 'Michael Bubl\u00e9',
        title: "It's Beginning to Look a Lot Like Christmas",
        anyArtist: true,
      },
      { artist: 'Paul McCartney', title: 'Wonderful Christmastime', anyArtist: true },
      { artist: 'John Lennon', title: 'Happy Xmas (War Is Over)', anyArtist: true },
      { artist: 'Band Aid', title: "Do They Know It's Christmas?", anyArtist: true },
      { artist: 'Chuck Berry', title: 'Run Rudolph Run', anyArtist: true },
      { artist: 'Gene Autry', title: 'Rudolph the Red-Nosed Reindeer', anyArtist: true },
      { artist: 'Gene Autry', title: 'Here Comes Santa Claus', anyArtist: true },
      { artist: 'Gene Autry', title: 'Frosty the Snowman', anyArtist: true },
      { artist: 'Darlene Love', title: 'Christmas (Baby Please Come Home)', anyArtist: true },
      { artist: 'The Ronettes', title: 'Sleigh Ride', anyArtist: true },
      { artist: 'Eartha Kitt', title: 'Santa Baby', anyArtist: true },
      { artist: 'Elvis Presley', title: 'Blue Christmas', anyArtist: true },
      { artist: 'The Pogues', title: 'Fairytale of New York', anyArtist: true },
      { artist: 'Judy Garland', title: 'Have Yourself a Merry Little Christmas', anyArtist: true },
      { artist: 'Bing Crosby', title: "I'll Be Home for Christmas", anyArtist: true },
      { artist: 'Dean Martin', title: "Baby, It's Cold Outside", anyArtist: true },
      { artist: 'Bing Crosby', title: 'Little Drummer Boy', anyArtist: true },
      {
        artist: 'Trans-Siberian Orchestra',
        title: 'Christmas Eve/Sarajevo 12/24',
        anyArtist: true,
      },
      { artist: 'Mannheim Steamroller', title: 'Deck the Halls', anyArtist: true },
      { artist: 'Vince Guaraldi Trio', title: 'Christmas Time Is Here', anyArtist: true },
      { artist: 'Vince Guaraldi Trio', title: 'Linus and Lucy' },
      { artist: 'Run-D.M.C.', title: 'Christmas in Hollis' },
      { artist: 'Kelly Clarkson', title: 'Underneath the Tree' },
      { artist: 'Ariana Grande', title: 'Santa Tell Me' },
      { artist: 'Justin Bieber', title: 'Mistletoe' },
      { artist: 'Chris Rea', title: 'Driving Home for Christmas' },
      { artist: 'Darlene Love', title: 'Winter Wonderland', anyArtist: true },
      { artist: 'Bing Crosby', title: 'Silent Night', anyArtist: true },
      { artist: 'Mariah Carey', title: 'O Holy Night', anyArtist: true },
      { artist: 'Pentatonix', title: 'Carol of the Bells', anyArtist: true },
      { artist: 'Frank Sinatra', title: 'Jingle Bells', anyArtist: true },
      { artist: 'Leroy Anderson', title: 'Sleigh Ride', anyArtist: true },
      {
        artist: 'Pyotr Ilyich Tchaikovsky',
        title: 'Dance of the Sugar Plum Fairy',
        anyArtist: true,
      },
      { artist: 'Thurl Ravenscroft', title: "You're a Mean One, Mr. Grinch", anyArtist: true },
      { artist: 'Bing Crosby', title: 'Do You Hear What I Hear?', anyArtist: true },
      { artist: 'Andy Williams', title: 'Happy Holiday', anyArtist: true },
      {
        artist: 'Perry Como',
        title: "It's Beginning to Look a Lot Like Christmas",
        anyArtist: true,
      },
      { artist: "Shakin' Stevens", title: 'Merry Christmas Everyone', anyArtist: true },
      { artist: 'Slade', title: 'Merry Xmas Everybody', anyArtist: true },
      { artist: 'Wizzard', title: 'I Wish It Could Be Christmas Everyday', anyArtist: true },
      { artist: 'Donny Hathaway', title: 'This Christmas', anyArtist: true },
      { artist: 'Stevie Wonder', title: 'Someday at Christmas', anyArtist: true },
      { artist: 'The Jackson 5', title: 'I Saw Mommy Kissing Santa Claus', anyArtist: true },
      { artist: 'Bruce Springsteen', title: "Santa Claus Is Comin' to Town", anyArtist: true },
      { artist: 'Dolly Parton', title: 'Hard Candy Christmas', anyArtist: true },
      { artist: 'Joni Mitchell', title: 'River' },
      { artist: 'Harry Simeone Chorale', title: 'The Little Drummer Boy', anyArtist: true },
      { artist: 'Paul Simon', title: 'Getting Ready for Christmas Day' },
    ],
    onlineQueries: [
      'christmas classics',
      'christmas pop',
      'classic christmas music',
      'christmas hits',
    ],
    onlineTitleWord: 'christmas',
    onlineMinPlaylists: 1,
    window: { startMonth: 12, startDay: 1, endMonth: 12, endDay: 26 },
    blendWithTaste: false,
  },
  {
    key: 'summer',
    label: 'Summer',
    theme:
      'Summer: songs about summertime, sunshine, heat, the beach, surfing, road trips, vacations, and summer nights -- plus the feel-good songs everyone plays at a summer barbecue',
    genreKeywords: ['surf', 'tropical', 'beach music', 'yacht rock', 'reggae', 'dancehall', 'soca'],
    titleKeywords: [
      'summer',
      'summertime',
      'sunshine',
      'sunny',
      'sunset',
      'beach',
      'heat wave',
      'heatwave',
      'vacation',
      'tropical',
      'tropicana',
      'island',
      'poolside',
      'surf',
      'surfin',
      'margarita',
      'margaritaville',
      'boardwalk',
      'bikini',
      'july',
      'endless summer',
    ],
    songs: [
      { artist: 'Will Smith', title: 'Summertime' },
      { artist: 'DJ Jazzy Jeff & The Fresh Prince', title: 'Summertime' },
      { artist: 'Martha and the Vandellas', title: 'Heat Wave' },
      { artist: 'Martha Reeves & The Vandellas', title: 'Heat Wave' },
      { artist: "The Lovin' Spoonful", title: 'Summer in the City' },
      { artist: 'Mungo Jerry', title: 'In the Summertime' },
      { artist: 'Bryan Adams', title: "Summer of '69" },
      { artist: 'Don Henley', title: 'The Boys of Summer' },
      { artist: 'The Beach Boys', title: "Surfin' U.S.A." },
      { artist: 'The Beach Boys', title: 'Good Vibrations' },
      { artist: 'The Beach Boys', title: 'Kokomo' },
      { artist: 'The Beach Boys', title: 'California Girls' },
      { artist: 'The Beach Boys', title: "Wouldn't It Be Nice" },
      { artist: 'Katrina and the Waves', title: 'Walking on Sunshine' },
      { artist: 'Bill Withers', title: 'Lovely Day' },
      { artist: 'Bob Marley & The Wailers', title: 'Three Little Birds' },
      { artist: 'Bob Marley', title: 'Three Little Birds' },
      { artist: 'Bob Marley & The Wailers', title: 'Is This Love' },
      { artist: 'Sublime', title: 'Santeria' },
      { artist: 'Sublime', title: 'What I Got' },
      { artist: 'Sublime', title: 'Summertime' },
      { artist: 'Kenny Chesney', title: 'When the Sun Goes Down' },
      { artist: 'Jimmy Buffett', title: 'Margaritaville' },
      { artist: 'Zac Brown Band', title: 'Toes' },
      { artist: 'Harry Styles', title: 'Watermelon Sugar' },
      { artist: 'Katy Perry', title: 'California Gurls' },
      { artist: 'Calvin Harris', title: 'Summer' },
      { artist: 'Lana Del Rey', title: 'Summertime Sadness' },
      { artist: 'Eddie Cochran', title: 'Summertime Blues' },
      { artist: 'Alice Cooper', title: "School's Out" },
      { artist: 'Kool & The Gang', title: 'Celebration' },
      { artist: 'Smash Mouth', title: 'All Star' },
      { artist: 'Smash Mouth', title: "Walkin' on the Sun" },
      { artist: 'Sheryl Crow', title: 'Soak Up the Sun' },
      { artist: 'Jack Johnson', title: 'Banana Pancakes' },
      { artist: 'Jason Mraz', title: "I'm Yours" },
      { artist: 'OutKast', title: 'Hey Ya!' },
      { artist: 'Pharrell Williams', title: 'Happy' },
      { artist: 'Daft Punk', title: 'Get Lucky' },
      { artist: 'Mark Ronson', title: 'Uptown Funk' },
      { artist: 'Bruno Mars', title: 'Uptown Funk' },
      { artist: 'Lizzo', title: 'Juice' },
      { artist: 'Dua Lipa', title: 'Levitating' },
      { artist: 'Bananarama', title: 'Cruel Summer' },
      { artist: 'Taylor Swift', title: 'Cruel Summer' },
      { artist: 'Kid Rock', title: 'All Summer Long' },
      { artist: 'Nelly', title: 'Hot in Herre' },
      { artist: 'Will Smith', title: 'Miami' },
      { artist: 'The Drifters', title: 'Under the Boardwalk' },
      { artist: 'Otis Redding', title: "(Sittin' On) The Dock of the Bay" },
      { artist: 'The Kinks', title: 'Sunny Afternoon' },
      { artist: 'Seals and Crofts', title: 'Summer Breeze' },
      { artist: 'Seals & Crofts', title: 'Summer Breeze' },
      { artist: 'Ella Fitzgerald', title: 'Summertime', anyArtist: true },
      { artist: 'George Gershwin', title: 'Summertime', anyArtist: true },
      { artist: 'Luis Fonsi', title: 'Despacito' },
      { artist: 'Sean Paul', title: 'Temperature' },
      { artist: 'Rihanna', title: 'Pon de Replay' },
      { artist: 'Vampire Weekend', title: 'A-Punk' },
      { artist: 'Weezer', title: 'Island in the Sun' },
      { artist: 'The Isley Brothers', title: 'Summer Breeze' },
      { artist: 'Jimmy Cliff', title: 'I Can See Clearly Now' },
      { artist: 'Johnny Nash', title: 'I Can See Clearly Now' },
      { artist: 'Wham!', title: 'Club Tropicana' },
      { artist: 'Elvis Presley', title: 'Blue Hawaii' },
      { artist: "The B-52's", title: 'Love Shack' },
      { artist: 'Bobby Darin', title: 'Beyond the Sea' },
      { artist: 'Dick Dale', title: 'Misirlou' },
      { artist: 'The Surfaris', title: 'Wipe Out' },
      { artist: 'The Chantays', title: 'Pipeline' },
    ],
    onlineQueries: [
      'summer barbecue',
      'summer vibes',
      'summer party',
      'summer hits',
      'summer songs',
    ],
    onlineTitleWord: 'summer',
    onlineMinPlaylists: 2,
    window: { startMonth: 6, startDay: 1, endMonth: 8, endDay: 31 },
    blendWithTaste: true,
  },
]

export function getSeasonalPreset(key: string | undefined): SeasonalPreset | undefined {
  return SEASONAL_PRESETS.find((p) => p.key === key)
}

export function isWithinSeasonalWindow(preset: SeasonalPreset, now: Date): boolean {
  const month = now.getMonth() + 1
  const day = now.getDate()
  const value = month * 100 + day
  const start = preset.window.startMonth * 100 + preset.window.startDay
  const end = preset.window.endMonth * 100 + preset.window.endDay
  if (start <= end) return value >= start && value <= end
  // Window wraps the year boundary.
  return value >= start || value <= end
}
