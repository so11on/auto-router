---
name: gemini-offload
description: Offload reading to Gemini (cheap, 1M-token window) instead of reading it yourself. Use when you must read more than about 20k tokens of files, logs or a whole folder, a PDF/image/audio/video, search the web with sources, get an independent second opinion on a diff, or run many small independent jobs. It returns only the answer, so your context stays small.
---

# Gemini offload

Run these from the shell. Each prints a short answer plus a one-line footer with the model, the tokens and the cost. The tool masks
secrets and personal data before anything leaves the machine, and refuses what the safety settings forbid.

| Need | Command |
|---|---|
| Understand a large file, folder or log without reading it | `node __AR_ROOT__/ar.mjs gemini digest <paths...> --ask "<question>"` |
| PDF, image, audio or video | `node __AR_ROOT__/ar.mjs gemini media <file> --ask "<question>"` |
| Web research with sources | `node __AR_ROOT__/ar.mjs gemini research "<question>"` |
| Independent review of a diff | `node __AR_ROOT__/ar.mjs gemini review --diff <git range>` (or pipe a diff in) |
| Many small independent jobs, not urgent, half price | write `jobs.jsonl` (`{"key": "...", "prompt": "..."}` per line), then `... gemini batch submit jobs.jsonl`, later `... gemini batch collect <name>` |

Rules:
- Ask a narrow question. The answer is cut at 8000 characters; a vague question wastes the call.
- Use it for READING and SUMMARISING. Make the edits and the decisions yourself.
- Its answers are a second source, not the truth: verify anything you are about to act on (a file path, a line, a version number).
- Do not use it for small files you can read in one call; the round trip costs more than it saves.
- A refusal (`gemini <task>: ...`) says why (a disabled feature, a sensitive content, a missing key). Do not work around it; tell the user.
