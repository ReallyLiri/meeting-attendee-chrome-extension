# Meeting Attendee Chrome Extension

<img src="chrome-extension/public/attendee.png" alt="logo" style="max-width: 300px;">

A silent meeting attendee to listen on your behalf and summarize the meeting for you. Including transcription and screenshots.

<img src="https://i.imgur.com/sjcaKpK.png" alt="options" style="max-width: 300px;">

![action](https://i.imgur.com/Te24EaU.gif)

![viewer](https://i.imgur.com/L35sLNI.gif)

## Chrome Extension

To build the Chrome extension, run:

```shell
yarn
yarn build
```

To install the extension, open Chrome and navigate to `chrome://extensions/`, enable "Developer mode", and load the unpacked extension from the `public` directory.

<img src="https://i.imgur.com/IozCst5.png" alt="public dir" style="max-width: 300px;">

## Server

Create a `.env` file in the `server` directory with the following content:

```env
HF_TOKEN=<your_huggingface_token>
MODEL_DIR=model
WORKING_DIR=./data
OUTPUT_DIR=./output
PORT=8017
``` 

### Transcription server

### Docker

```shell
docker compose up -d
```

### Local

Run from `server` directory.

```shell
uv run --env-file=.env src/server.py
```

Web app available at `http://localhost:8017`.

### Transcription CLI

```shell
uv run --env-file=.env src/transcribe.py <path>
```
