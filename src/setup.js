import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';
import { createApi } from './api.js';
import { createChatGpt } from './chatgpt.js';
import { CONFIG_FILE, loadConfig, saveConfig } from './config.js';

/**
 * One-time setup: romva.space sign-in, the save folder, and ChatGPT.
 * Run again any time to change them. The password is sent to romva.space once
 * and never written to disk.
 */

async function askHidden(question) {
  stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\r' || char === '\n' || char === '\u0004') {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (char === '\u0003') {
        process.exit(1);
      } else if (char === '\u0008' || char === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += char;
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
  const email = await ask('romva.space email', '');
  rl.pause();
  const password = await askHidden('romva.space password: ');
  rl.resume();

  const api = createApi(config.apiUrl);
  const user = await api.login(email, password);
  console.log(`Signed in as ${user?.email ?? email}.`);

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
