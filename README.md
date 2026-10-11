# Jason & Olivia's Music Analysis

How alike are Jason's Spotify listening and Olivia's YouTube Music listening? (Names are set in `PEOPLE` at the top of `app.js`.)

Drop in your Spotify data export and your Google Takeout export. The page counts plays per artist,
looks up each artist's genres in a public music database, and shows:

- **Overall similarity**, plus three parts: genre match (how closely the detailed genre mixes line up),
  genre family overlap (broad styles like Rock or Hip hop & rap) and artist overlap (weighted by plays)
- **Top genres** side by side, with a Families view and a table view
- Which genres lean more to each service
- Artists on both, and the top artists on only one

Everything runs in the browser. Your files are never uploaded; only artist names are sent to the genre database.

## Sharing

Under the results, **Copy link** makes a link to the report. The report itself is packed into the link
(after the `#`), so there's no server and nothing is stored anywhere; whoever opens it sees the same
results without your files. **Save image** downloads a portrait card for posting. On a phone, both open
the share sheet. Links only work once the page is on a website, such as GitHub Pages.

## Run it

No build step. Serve the folder with any static server:

```
python3 -m http.server 8000
```

then open http://localhost:8000. (Opening `index.html` directly won't work, because browsers block
JavaScript modules from `file://`.)

## Getting your data

**Spotify:** [spotify.com/account/privacy](https://www.spotify.com/account/privacy/) → request *Account data*
(about 5 days) or *Extended streaming history* (up to 30 days, covers the whole account). Drop the zip as is.

**YouTube Music:** [takeout.google.com](https://takeout.google.com/) → *Deselect all* → tick *YouTube and YouTube Music*,
keep *history* and set its format to JSON (HTML works too). Drop the zip as is.

Files it reads:

| Service | Files |
|---|---|
| Spotify | `StreamingHistory_music_*.json`, `StreamingHistory*.json`, `Streaming_History_Audio_*.json`, `endsong_*.json`, `YourLibrary.json`, or a CSV |
| YouTube Music | `watch-history.json`, `watch-history.html`, `music library songs.csv` |

CSV files are read by their column names, so most exports work: streaming history saved as CSV,
playlist or liked-song exports from tools like Exportify, or any CSV with an artist column. A CSV with
a play time or date column counts as listening history; one without counts as saved songs.

Spotify plays shorter than 30 seconds are skipped. Only YouTube history entries from YouTube Music are counted.
If a service has no play history, its saved songs are used instead.

## Genre sources

- **MusicBrainz** (default): free with no key, but limited to about one artist a second, so the top 100 artists
  from each service take two to three minutes the first time.
- **Last.fm**: needs a free [API key](https://www.last.fm/api/account/create); faster and with richer tags.

Lookups are remembered in the browser, so running it again is quick. Tags that aren't genres
("seen live", countries, decades) are filtered out.

## Files

- `parsers.js`: reads each export format
- `genres.js`: genre lookups, tag cleanup and broad genre families
- `compare.js`: builds the listening profiles and the similarity scores
- `app.js`: the page
