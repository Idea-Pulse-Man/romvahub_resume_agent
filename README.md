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

If the cover letter fails after the Resume is made, the application comes back
later for its cover letter alone. If the files cannot be written to the save
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

## Use

- **Start resume / Stop** on the romva.space Applications page turns Resume
  making on or off for every worker, this agent included.
- **Start apply / Stop** turns Apply on or off (see below).
- Log: `%APPDATA%\RomvaResumeAgent\agent.log`
- Settings: `%APPDATA%\RomvaResumeAgent\config.json` (or run `npm run setup` again)
- Run in a window instead (to watch it): `npm start` — one application only: `npm run once`
- Leave the agent's Chrome window open (minimised is fine). If ChatGPT signs
  out, the agent waits and carries on once you sign in again.

## Apply (fill in the application forms — you submit)

Allow it on this computer once, in `config.json` (off by default, so a
computer that only makes Resumes — a server — never opens job pages):

```json
"apply": { "enabled": true, "tabs": 3 }
```

Then press **Start apply** on the romva.space Applications page (**Stop** turns
it off again: no new tabs open; the open ones stay). While it is on, the agent
keeps `tabs` job tabs open in its Chrome window. Each one is the
application page of a Draft whose Resume and cover letter are made, already
filled in from the Profile — name, email, phone, links, location, current
company and title, the cover letter box, work authorisation, sponsorship,
relocation and the voluntary EEO questions — with the Resume and cover letter
PDFs attached.

- **It never submits.** Check each tab, answer anything left, click Submit.
- **The form's own questions** — text boxes, drop-downs, radios, tick boxes,
  Yes/No buttons — are answered by ChatGPT from the Resume and the job post,
  in short plain answers. A question that offers "I don't wish to answer"
  ("Decline to self-identify", "Prefer not to say"…) gets that option, except
  work authorisation, sponsorship and relocation. Fixed answers:
  - **Relocation:** always **No** (you do not move for work).
  - **Sponsorship:** No. **Authorised to work:** Yes.
  - **Salary:** the middle of the pay range given in the job post or on the
    page; **150000** when none is given.
  - **How did you hear about us:** **Jobright AI** if offered, else a job
    board option ("Jobright AI" typed into a text box).
  - **Referrer's name / email:** never written.

  A question ChatGPT cannot answer from the Resume is left empty for you, and
  a field you have already filled is never changed.
- When the page says the application was sent, the tab closes and the next
  job opens. Closing a tab yourself also counts as done with that job.
- No screenshot is taken and the status on romva.space is not changed.
- Opened jobs are remembered (14 days) in `%APPDATA%\RomvaResumeAgent\apply-handled.json`;
  delete that file to open them again.

### Sites that need a sign-in — `Alt+V`

A job whose page wants you to sign in or create an account (a password box,
or a page with no form that says "Sign in") is **skipped**: nothing is typed,
its tab **stays open**, and the next job opens. Then, in that tab:

1. sign in (or sign up) yourself, and go to the application form;
2. press **Alt+V** — the agent fills the form for that job and ChatGPT
   answers its questions, as above.

The key works in any tab of the agent's Chrome, whether Apply is at Start or
Stop. Its job is found from the tab (one the agent opened, or opened from
one), else from the page itself: the company in the site's address or named
on the page, among the skipped jobs, the open ones and the Drafts ready on
romva.space — and the form is filled at once. Only when the page matches no
job, or several, does the banner list jobs to choose from; nothing is touched
until you choose. On a sign-in page the key does nothing but say so. Skipped
jobs are remembered (14 days) in `%APPDATA%\RomvaResumeAgent\apply-parked.json`.

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
| `apply.tabs` | `3` | job tabs open at once |
| `chrome.path` | first Chrome/Edge found | |
| `chrome.profileDir` | `%LOCALAPPDATA%\RomvaResumeAgent\chrome` | ChatGPT sign-in lives here |
| `chrome.debugPort` | `9334` | |
| `chrome.temporaryChat` | `true` | keep chats out of ChatGPT history |
| `chrome.answerTimeoutMinutes` | `8` | |
