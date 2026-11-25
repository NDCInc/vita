# Vita

[Vita](https://vita.nestdigital.ca/) is a free résumé builder by NDC Inc. Open a PDF, Word file, photo, saved Vita draft or LinkedIn PDF. You can also paste text, add a LinkedIn profile link, or answer a few questions. Transcripts and certificates can be added alongside a résumé. Review the details you want to keep and download a PDF or editable Word document.

The same PDF is used for preview and download. A Word file can be edited in Word and reopened in Vita. The optional Vita backup carries the draft and its original text to another device. Backups made by older versions also open. The browser automatically saves the current draft on this device when storage is available.

Use **Dictate** beside a writing field and speak in English. GPT-Live-Transcribe shows words as you talk. Select **Use recording** to put the finished text into the field, where you can edit or undo it. If the live session fails, Vita finishes the same recording with Amazon Transcribe. Vita also reads voice memos with Amazon Transcribe. Résumé imports, scan reading, editing and exports run on the device.

## Develop

Install Node.js 22.12 or newer and Python 3.9 or newer. From the source directory, run `npm ci --ignore-scripts` and `npm run dev`. Build for a static host with `npm run build`. Vita copies its pinned scan languages during the build. The microphone uses same-origin `POST /api/dictation/live` for the live session and `POST /api/dictation` for a finished recording.

Run `node qa/model.mjs`, `node qa/supporting-model.mjs` and `node qa/evidence.mjs` for checks of the underlying logic. [Browser and document tests](qa/README.md)

## Release

After a production build, run `python3 scripts/bundle.py --manifest release.json`. This writes `dist/source.zip` and records a SHA-256, content type and cache policy for each public object. The optional stack in `infra/site.yaml` uses CloudFront, a private Canadian S3 website origin and a separate private versioned research bucket. Configure a certificate in Northern Virginia for a custom hostname. To enable dictation, install the backend dependencies inside `voice-service`, run `node --test handler.test.mjs`, and bundle `handler.mjs` with esbuild for Node 24 as `handler.js`. Zip that file at the archive root and upload it to the private research bucket. Set `VoiceCodeKey` and `VoiceCodeVersion` to the verified archive. The function accepts up to two minutes of audio per recording.

For live dictation, map the exact deployed Vita Lambda role to an OpenAI service account with Realtime request permission. Then provide its `VoiceLiveProvider` and `VoiceLiveAccount` IDs to the stack. AWS and OpenAI exchange short-lived identity tokens. The Lambda returns only the answer to the browser's WebRTC offer. An SQS timer ends abandoned sessions. DynamoDB tracks the live and fallback allowances separately by UTC calendar month. The live allowance reserves 145 seconds per session for recording and shutdown. Set an enforced spend limit in the dedicated OpenAI project as an additional control. [OpenAI setup for AWS](https://developers.openai.com/api/docs/guides/workload-identity-federation/aws)

The release operator runs `python3 scripts/archive-research.py --manifest release.json --register research.md --output evidence.zip path/to/test-report.json` with the project's research register and generated QA reports. A separately held fictional benchmark can be included with `--synthetic-benchmark`. Keep research inputs separate from the website directory. `scripts/upload.py` accepts scoped S3 upload targets as JSON on standard input. Its `research` array supplies entries with a local path, S3 key, SHA-256, headers and signed URL. The `site` array supplies the same fields using a distribution-relative key. A production publish archives its research first, uploads assets and source, and publishes the new index last. Retain the returned S3 version IDs and verify the public object hashes.

Vita software uses the MIT license. NDC Inc. and Vita names and marks identify the original project. [License](LICENSE) · [Third-party materials](THIRD-PARTY.md)
