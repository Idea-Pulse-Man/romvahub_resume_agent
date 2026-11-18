# Romva Resume Agent (Windows)

Makes the Resume and cover letter for every new **Draft** application on
romva.space, in the background, with **your own signed-in ChatGPT** — no API
key. Starts by itself when you sign in to Windows.

For each application it:

1. asks romva.space for the next one (each application goes to one worker only —
   this agent, the Chrome extension, or the local API),
2. opens a new ChatGPT chat with the Profile's Resume prompt and the job post,
3. sends the answer to romva.space, which builds the Resume (the Profile's Word
   template + PDF) and attaches it to the application,
4. does the same for the cover letter,
5. saves the five files to `<save folder>\<Profile>\<Company_Role>\`:
   job description (.txt), Resume (.pdf, .docx), cover letter (.pdf, .docx).

Each chat is a temporary chat in its own tab, closed when it is done.

Applications are taken in the order of the Applications list (No 1, 2, 3…).
For each one the agent makes whatever is missing — the Resume and cover
letter, or just the cover letter if the Resume is already there (it failed,
or the agent was stopped in between) — and then goes on to the next. If the files cannot be written to the save
folder (a path too long, a full disk), they are still on romva.space and the
work carries on.

## Needs

- Windows 10/11, **Node.js 20+** (https://nodejs.org), **Google Chrome** (or Edge)
- a romva.space account that can see the applications (an admin sees all)
- a ChatGPT account (sign in once in the agent's Chrome window)

## Install

```powershell
cd resume_agent
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Setup asks for the romva.space address, email and password (the password is
used once and not stored), the save folder, and this computer's name; then a
Chrome window opens on chatgpt.com — sign in there once.

### Signing in again by itself — `credentials.txt`

romva.space can end the agent's sign-in (for example when the same account
is signed out elsewhere). To have the agent sign in again on its own, copy
`credentials.example.txt` to `credentials.txt` in this folder and fill it in:

```
email=you@example.com
password=your password
```

It is read only when the sign-in has ended, and read afresh each time, so it
can be edited while the agent runs. A refused email or password is tried
again after 5 minutes. `credentials.txt` holds the password in plain text:
it is kept out of git (`.gitignore`), so keep it on this computer only.

## Use

- **Start resume / Stop** on the romva.space Applications page turns Resume
  making on or off for every worker, this agent included.
- Log: `%APPDATA%\RomvaResumeAgent\agent.log`
- Settings: `%APPDATA%\RomvaResumeAgent\config.json` (or run `npm run setup` again)
- Run in a window instead (to watch it): `npm start` — one application only: `npm run once`
- Leave the agent's Chrome window open (minimised is fine). If ChatGPT signs
  out, the agent waits and carries on once you sign in again.

## Apply

This agent only makes Resumes and cover letters. Filling in the application
forms (the **Apply** button on romva.space, and **Alt+V** on sites that need
a sign-in) is done by the **Romva Apply** Chrome extension in the
[`altv`](../altv/) folder.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1          # keeps settings
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge   # deletes them too
```

## Settings (`config.json`)

| Key | Default | |
| --- | --- | --- |
| `apiUrl` | `https://www.romva.space` | |
| `saveDir` | `Documents\Resume` | where the folders go |
| `workerName` | `agent · <computer>` | shown on romva.space |
| `pollSeconds` | `20` | how often to look for new applications |
| `chrome.path` | first Chrome/Edge found | |
| `chrome.profileDir` | `%LOCALAPPDATA%\RomvaResumeAgent\chrome` | ChatGPT sign-in lives here |
| `chrome.debugPort` | `9334` | |
| `chrome.temporaryChat` | `true` | keep chats out of ChatGPT history |
| `chrome.answerTimeoutMinutes` | `8` | |
