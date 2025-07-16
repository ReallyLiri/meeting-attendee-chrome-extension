# Meeting Attendee Chrome Extension

![logo](chrome-extension/public/attendee.png)

A silent meeting attendee to listen on your behalf and summarize the meeting for you. Including transcription and screenshots.

![action](https://i.imgur.com/Te24EaU.gif)

![viewer](https://i.imgur.com/L35sLNI.gif)

## Chrome Extension

To build the Chrome extension, run:

```shell
yarn
yarn build
```

To install the extension, open Chrome and navigate to `chrome://extensions/`, enable "Developer mode", and load the unpacked extension from the `public` directory.

![public dir](https://i.imgur.com/IozCst5.png)

## Transcription server

Run from `server` directory.

```
uv run --env-file=.env src/server.py
```

Web app available at `http://localhost:8017`.

## Transcription CLI

```shell
uv run --env-file=.env src/transcribe.py <path>
```

## Summarization CLI

```shell
uv run --env-file=.env src/summarize.py <path>
```
