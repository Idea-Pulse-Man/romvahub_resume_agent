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

## Use

- **Start / Stop** on the romva.space Applications page turns every worker on
  or off, this agent included.
- Log: `%APPDATA%\RomvaResumeAgent\agent.log`
- Settings: `%APPDATA%\RomvaResumeAgent\config.json` (or run `npm run setup` again)
- Run in a window instead (to watch it): `npm start` — one application only: `npm run once`
- Leave the agent's Chrome window open (minimised is fine). If ChatGPT signs
  out, the agent waits and carries on once you sign in again.

## Apply (fill in the application forms — you submit)

Turn it on in `config.json`:

```json
"apply": { "enabled": true, "tabs": 3 }
```

Then the agent keeps `tabs` job windows open in its Chrome. Each one is the
application page of a Draft whose Resume and cover letter are made, already
filled in from the Profile — name, email, phone, links, location, current
company and title, the cover letter box, work authorisation, sponsorship,
relocation and the voluntary EEO questions — with the Resume and cover letter
PDFs attached.

- **It never submits.** Check each window, answer anything left, click Submit.
- When the page says the application was sent, the window closes and the next
  job opens. Closing a window yourself also counts as done with that job.
- No screenshot is taken and the status on romva.space is not changed.
- Opened jobs are remembered (14 days) in `%APPDATA%\RomvaResumeAgent\apply-handled.json`;
  delete that file to open them again.
- Sites that need an account (Workday, ADP…) open at their sign-in page; sign
  in once in the agent's Chrome and the session is kept.

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
| `apply.enabled` | `false` | open and fill application forms (you submit) |
| `apply.tabs` | `3` | job windows open at once |
| `chrome.path` | first Chrome/Edge found | |
| `chrome.profileDir` | `%LOCALAPPDATA%\RomvaResumeAgent\chrome` | ChatGPT sign-in lives here |
| `chrome.debugPort` | `9334` | |
| `chrome.temporaryChat` | `true` | keep chats out of ChatGPT history |
| `chrome.answerTimeoutMinutes` | `8` | |
