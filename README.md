# Meeting Attendee Chrome Extension

<img src="chrome-extension/public/attendee.png" alt="logo" width="420">

A silent meeting attendee to listen on your behalf and summarize the meeting for you. Including transcription and screenshots.

<img src="https://i.imgur.com/sjcaKpK.png" alt="options" width="600">

![action](https://i.imgur.com/Te24EaU.gif)

![viewer](https://i.imgur.com/L35sLNI.gif)

## Chrome Extension

To build the Chrome extension, run:

```shell
yarn
yarn build
```

To install the extension, open Chrome and navigate to `chrome://extensions/`, enable "Developer mode", and load the unpacked extension from the `public` directory.

<img src="https://i.imgur.com/IozCst5.png" alt="public dir" width="600">

## Server

You will need a Hugging Face token to run the server. You can get one by creating an account on [Hugging Face](https://huggingface.co/) and generating a token in your account settings. You don't need to pay anything, you just need to create an account and accept the terms of these models: [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1).

Copy `.env.template` to `.env` in the `server` directory and adjust as needed, including the Hugging Face token you obtained earlier.

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
