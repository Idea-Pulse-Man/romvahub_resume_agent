# Romva Resume Agent (Windows)

Makes the Resume and cover letter for every new **Draft** application on
romva.space, in the background, with **your own signed-in ChatGPT** — no API
key. A small window (`gui\RomvaAgent.exe`, ~35 KB) runs it, shows its log, and
holds the token; it starts with Windows, in the tray.

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
- a Romva token for the Profile (from the Super Admin, romva.space → Tokens)
- a ChatGPT account (sign in once in the agent's Chrome window)

## Install

```powershell
cd resume_agent
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The **Romva Resume Agent** window opens, stopped — nothing runs until you say
so:

1. **Change token…** — paste the **Romva token**,
2. **Save folder…** — pick where the Resumes are saved (default `Documents\Resume`),
3. **Start**.

When the agent first needs ChatGPT, a Chrome window opens on chatgpt.com — sign
in there once.

(`npm run setup` still works from a terminal, to change this computer's name.)

## The window

- **● Running / Stopped**, with **Start** and **Stop**. Opened by hand, the
  window never starts the agent by itself; **Start** waits until a token is
  set. If the agent stops by itself it is started again (after 5 s, 10 s,
  30 s, then every minute) — not when the token is missing or refused: then it
  waits for a new one. Started with Windows (in the tray), the agent goes on as
  it was left: running if it was running.
- **Token:** whether one is saved, its Profile and end date. The token itself
  is never shown; **Change token…** replaces it (checked with romva.space
  first, so a wrong one is never saved).
- **Save to:** the save folder; **Save folder…** changes it (it is made and
  written to once first), **Open** opens it. A running agent uses a new folder
  from its next files on — no restart.
- **Full log** and **Error log** (warnings and errors only), live, in local
  time. **Copy** and **Save .txt** take the tab that is open. **Track log**
  on: the log scrolls down to each new line, so the newest is always in view;
  off: it stays where you scrolled it.
- The **X** hides the window to the tray; right-click the tray icon → **Exit**
  closes it and stops the agent. **Start with Windows** is a tick box.
- Rebuild after changing `gui\RomvaAgent.cs`: `npm run gui`.

### The Romva token — no sign-in

The agent does not sign in to romva.space with an email and password. It uses
a token for one Profile, made by the Super Admin on romva.space → **Tokens**
(pick the Profile, Generate token, copy it — it is shown once). The agent then
makes that Profile's Resumes and cover letters, and sees nothing else.

The token is kept in `%APPDATA%\RomvaResumeAgent\config.json` (`"token"`), or
taken from the `ROMVA_TOKEN` environment variable. It expires on the date the
Super Admin chose (the window shows it, and the agent warns in its log during
the last week); when it has expired or been revoked, the agent stops with "The
Romva token was refused" — click **Change token…** and paste a new one. (An old `credentials.txt` is no longer
read and can be deleted.)

## Use

- **Start resume / Stop** on the romva.space Applications page turns Resume
  making on or off for every worker, this agent included.
- Log: in the window, or `%APPDATA%\RomvaResumeAgent\agent.log`
- Settings: `%APPDATA%\RomvaResumeAgent\config.json` (or run `npm run setup` again)
- Without the window (in a terminal): `npm start` — one application only: `npm run once`
- Leave the agent's Chrome window open (minimised is fine). If ChatGPT signs
  out, the agent waits and carries on once you sign in again.
- A proxy extension in the agent's Chrome (e.g. SmartProxy) that sends
  chatgpt.com through a proxy with a password can fail now and then
  (`net::ERR_INVALID_AUTH_CREDENTIALS`). The agent then pauses and tries
  again, and the application is handed back without being counted as failed.
  Turn the proxy off for chatgpt.com if ChatGPT does not need it.
- No chat can hold an application at "Making…" for good: a page that never
  reports back is not waited for, and a chat gives up after
  `answerTimeoutMinutes` + 10 minutes.

## Apply

This agent only makes Resumes and cover letters. Filling in the application
forms (the **Apply** button on romva.space, and **Alt+V** on sites that need
a sign-in) is done by the **Romva Apply** Chrome extension in the
[`altv`](../altv/) folder.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1          # keeps settings and the token
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge   # deletes them too
```

## Settings (`config.json`)

| Key | Default | |
| --- | --- | --- |
| `apiUrl` | `https://www.romva.space` | |
| `saveDir` | `Documents\Resume` | where the folders go (the window's **Save folder…**) |
| `workerName` | `agent · <computer>` | shown on romva.space |
| `pollSeconds` | `20` | how often to look for new applications |
| `chrome.path` | first Chrome/Edge found | |
| `chrome.profileDir` | `%LOCALAPPDATA%\RomvaResumeAgent\chrome` | ChatGPT sign-in lives here |
| `chrome.debugPort` | `9334` | |
| `chrome.temporaryChat` | `true` | keep chats out of ChatGPT history |
| `chrome.answerTimeoutMinutes` | `8` | |
