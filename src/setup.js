import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';
import { createApi } from './api.js';
import { createChatGpt } from './chatgpt.js';
import { CONFIG_FILE, loadConfig, saveConfig } from './config.js';

/**
 * One-time setup: the Romva token (from the Super Admin, romva.space → Tokens),
 * the save folder, and ChatGPT. Run again any time to change them.
 */

async function askHidden(question) {
  stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    // A paste arrives as one chunk (maybe ending in Enter): look at each character.
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') process.exit(1);
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const config = loadConfig();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (question, fallback) => (await rl.question(`${question} [${fallback}]: `)).trim() || fallback;

  console.log('Romva Resume Agent — setup\n');
  config.apiUrl = await ask('romva.space address', config.apiUrl);
  rl.pause();
  const typed = (await askHidden(`Romva token (rmv_...)${config.token ? ' [Enter: keep the current one]' : ''}: `)).trim();
  rl.resume();
  const token = typed || config.token;
  if (!token) throw new Error("No token given. Ask the Super Admin for your Profile's token (romva.space → Tokens).");

  const api = createApi(config.apiUrl, undefined, token);
  const me = await api.me();
  config.token = token;
  console.log(`The token works: this agent makes ${me?.token?.profile?.name ?? 'its Profile'}'s Resumes.`);

  config.saveDir = await ask('Save the files under', config.saveDir);
  config.workerName = await ask('Name of this computer (shown on romva.space)', config.workerName);
  rl.close();
  saveConfig(config);
  console.log(`Saved ${CONFIG_FILE}.`);

  console.log('\nOpening the agent\'s Chrome window on chatgpt.com.');
  console.log('Sign in to ChatGPT there once (the window remembers it), then come back here.');
  const chatgpt = createChatGpt(config.chrome);
  await chatgpt.open();
  for (let i = 0; i < 120; i += 1) {
    if (await chatgpt.ready()) {
      console.log('ChatGPT is signed in. Setup is done.');
      chatgpt.disconnect();
      return;
    }
    if (i === 0) console.log('Waiting for the ChatGPT sign-in… (up to 10 minutes)');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('ChatGPT is not signed in yet. The agent will wait for it when it runs.');
  chatgpt.disconnect();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`Setup failed: ${error.message}`);
    process.exit(1);
  },
);
