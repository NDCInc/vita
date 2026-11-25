# Vita browser regression tests

The suite exercises Vita through its public screens using fictional PDF, Word, text, and draft files. It reopens exported artifacts through independent PDF and Word readers. It also checks that the preview uses the downloaded PDF bytes and that résumé data stays off the network.

From the repository root, install Node dependencies and start a production preview:

```sh
npm ci
npm run build
npm run preview -- --port 4178 --strictPort
```

In another terminal, set up the test dependencies and run the suite:

```sh
npm install --no-save --package-lock=false --ignore-scripts playwright@1.65.1
npx playwright install chromium firefox webkit
python3 -m venv qa/.venv
qa/.venv/bin/python -m pip install 'PyMuPDF==1.26.5'
VITA_QA_PYTHON="$PWD/qa/.venv/bin/python" \
  VITA_BROWSERS=chromium,firefox,webkit node qa/suite.cjs
```

The suite targets `http://127.0.0.1:4178/` by default. Set `VITA_URL` to test a different deployment, `VITA_CASE` to filter test names, or `VITA_SUITE=smoke` for the release smoke checks. `VITA_QA_RESULTS` sets an alternate evidence directory. Each run writes a JSON report, fixture exports, and screenshots for failures. The desktop timing result measures a warmed browser using a two-page fixture.

Use `node qa/stage-server.cjs` to serve `dist` at `http://127.0.0.1:4393/` with the CloudFront content security policy. Run `VITA_SUITE=mobile VITA_BROWSERS=webkit VITA_DEVICE="iPhone 15" node qa/suite.cjs` for the touch and enlarged-text check. The suite also accepts the `iPad Pro 11 landscape` profile. These profiles test emulated touch and viewport behaviour.

The fixture binaries are included so browser runs use the same input bytes on every checkout. Run `fixtures.py` to refresh the generated fixtures. Its seven optional PDFs from the original comparative study are NDC-authored fictional cases. The included copies are used when the comparative study directory is absent.

Run `VITA_QA_PYTHON="$PWD/qa/.venv/bin/python" VITA_URL=http://127.0.0.1:4393/ VITA_BROWSERS=chromium node qa/experience.cjs` for profile reading order, scans, dictation, Word and draft transfers, and concurrent draft edits. This suite takes one browser per run. Repeat with Firefox and WebKit, and set `VITA_DEVICE` to a Playwright phone or tablet profile for touch checks. The production content security policy is used with the included stage server. Browser automation can exercise a synthetic microphone in Chromium. Set `VITA_LIVE_VOICE=1` for production tests against an authorized Vita endpoint. By default, the browser checks control the transcription responses. Use separate output directories for parallel runs.

The public English voice fixture was generated using CMU Flite 2.2, with the SLT voice reading a fictional work description. Original examples are synthetic. `profile-fixtures.py` rebuilds the profile and scan fixtures with PyMuPDF. Record test results through `scripts/archive-research.py` alongside the source manifest and the research register.

The synthetic microphone plays the same words with 1.2 seconds of silence before the sentence and three seconds afterward. This lets the browser finish opening its device and prevents the next loop from running into the recording. The ordinary voice memo has no added pauses. Test the real live route with `VITA_LIVE_VOICE=1 VITA_REQUIRE_PRIMARY=1` and test the real backup by adding `VITA_FORCE_FALLBACK=1` in place of `VITA_REQUIRE_PRIMARY=1`. Use `VITA_SYNTHETIC_MIC=1` to supply the same clip through Web Audio on WebKit. The forced failure is local to the test browser.
