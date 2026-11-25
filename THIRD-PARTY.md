# Third-party materials

Vita's own software uses the MIT license. The following notices also apply to redistributed assets.

- Optional English dictation uses OpenAI Realtime with Amazon Transcribe as a fallback. These are hosted services. AWS SDK dependencies are pinned in `voice-service/package-lock.json`. [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) · [Amazon Transcribe API](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_TranscribeAudio.html)
- Tesseract.js, the Tesseract engine and Tesseract training data are available under Apache 2.0. The English and French data packaging modules carry their own MIT notices. [Tesseract.js](https://github.com/naptha/tesseract.js) · [Training data](https://github.com/tesseract-ocr/tessdata_best) · [Engine license](licenses/Tesseract-Core.txt)
- The short English QA recording was synthesized from a fictional sentence with CMU Flite 2.2 and the SLT voice. [Flite](https://github.com/festvox/flite) · [Attribution](licenses/Flite.txt)
- Inter uses the SIL Open Font License. The font files are covered by their accompanying [font notice](src/assets/OFL-Inter.txt) and [Inter 4.1 notice](src/assets/OFL-Inter-4.1.txt).
- OpenResume served as a [comparative test reference](https://github.com/xitanggg/open-resume/tree/4f8255a2c763479837f69f1dccf2a3338730cd79). The Vita implementation uses its own code and fictional test inputs. OpenResume has its own AGPL-3.0 license.
- NDC Inc. and Vita marks identify the publisher. The MIT software license gives no trademark rights.

Package versions and source integrity values are recorded in package-lock.json. Dependencies retain their own licenses.
