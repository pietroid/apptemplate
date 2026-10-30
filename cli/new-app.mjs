#!/usr/bin/env node
// Creates a new app from the app template, end to end:
//
//   ./new-app                 asks, then does everything, step by step
//   ./new-app --resume <slug> picks an app up where it stopped (or fills in
//                             what was skipped, like the Google clients)
//
// What it does, in order: copies the template, has Claude rename and verify
// it, writes the local and production env files, commits as you, creates
// the GitHub repository, prepares the Raspberry Pi (/opt/<slug>, its .env,
// the tunnel's hostname), sets the deploy's secrets, pushes (which deploys)
// and turns the issue queue on. Every step says what it is doing, and every
// answer it needs says where to get it.
//
// Answers are kept in ~/.config/apptemplate/ (0600), so a run that stops can
// be resumed and nothing is asked twice. The Pi and Cloudflare settings
// shared by every app stay where scripts/gh_setup.sh keeps them:
// ~/.config/pi-deploy/deploy.env.
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'apptemplate');
const CONFIG = path.join(CONFIG_DIR, 'config.json');
const APPS = path.join(CONFIG_DIR, 'apps');
const DEPLOY_ENV = process.env.PI_DEPLOY_CONFIG ?? path.join(os.homedir(), '.config', 'pi-deploy', 'deploy.env');
// Never copied into a new app: the CLI is the template's own.
const NOT_COPIED = [/^cli\//, /^new-app$/];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writePrivate = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};
const writeJson = (file, value) => writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);

/** Runs a command and answers its output; throws with its stderr on failure. */
function sh(cmd, args, { cwd, input, env, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    const err = new Error(`${cmd} ${args.join(' ')} failed (${r.status})\n${(r.stderr || r.stdout || '').trim()}`);
    err.stdout = r.stdout; err.stderr = r.stderr; err.status = r.status;
    throw err;
  }
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status };
}

/** Runs a command attached to this terminal (for sudo prompts and live output). */
function live(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Runs a command, printing its output dimmed and indented under the step. */
function streamed(cmd, args, { cwd, env, filter } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let all = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      all += text;
      for (const line of text.split('\n')) {
        if (line.trim() && (!filter || filter(line))) console.log(`${pc.gray('│')}  ${pc.dim(line)}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve({ code: code ?? 1, output: all }));
  });
}

const has = (cmd) => sh('sh', ['-c', `command -v ${cmd}`], { allowFail: true }).ok;
const bail = (message) => { p.cancel(message); process.exit(1); };
const answer = async (promise) => {
  const value = await promise;
  if (p.isCancel(value)) bail('Stopped. Run it again to resume: nothing done so far is lost.');
  return value;
};
const title = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const reversed = (clientId) => `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;
const link = (url) => pc.cyan(pc.underline(url));

/** Parses a KEY=value file, ignoring comments and blanks. */
function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

/** Sets KEY=value in an env file, keeping its comments and order. */
function setEnv(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
  }
  writePrivate(file, text);
}

const envFile = (values) => `${Object.entries(values).map(([k, v]) => (k.startsWith('#') ? `\n${k}` : `${k}=${v ?? ''}`)).join('\n').trim()}\n`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const required = (what) => (v) => (v?.trim() ? undefined : `${what} is required`);
const isPostgres = (v) => (/^postgres(ql)?:\/\/\S+$/.test(v?.trim() ?? '') ? undefined : 'A connection string, starting with postgresql://');
const isGoogleId = (optional) => (v) => {
  if (optional && !v?.trim()) return undefined;
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v?.trim() ?? '') ? undefined : 'A client ID, like 1234-abc.apps.googleusercontent.com (Enter to skip)';
};

// ---------------------------------------------------------------------------
// Shared settings: asked once, for every app
// ---------------------------------------------------------------------------

async function sharedConfig() {
  const cfg = readJson(CONFIG, {});
  const first = !fs.existsSync(CONFIG);
  if (first) p.note('These are asked once and reused for every app.\nThey are kept in ~/.config/apptemplate/config.json (only you can read it).', 'First run');

  cfg.owner ??= sh('gh', ['api', 'user', '--jq', '.login']).out;
  cfg.projectsDir ??= path.dirname(TEMPLATE);
  cfg.domain ??= 'pietroteruya.dev';
  cfg.emails ??= sh('git', ['config', 'user.email'], { allowFail: true }).out;

  if (!cfg.openrouterKey) {
    // The key every app has used so far, if Lunna is next door.
    const lunna = readEnv(path.join(cfg.projectsDir, 'lunna', 'server', '.env.local'));
    if (lunna.OPENROUTER_API_KEY) {
      const reuse = await answer(p.confirm({ message: `Use the OpenRouter key and model Lunna uses (${lunna.OPENROUTER_MODEL || 'no model set'})?` }));
      if (reuse) { cfg.openrouterKey = lunna.OPENROUTER_API_KEY; cfg.openrouterModel = lunna.OPENROUTER_MODEL; }
    }
  }
  if (!cfg.openrouterKey) {
    p.note(`1. Open ${link('https://openrouter.ai/settings/keys')}\n2. Create key → name it "apps" → copy it (sk-or-…).\nEvery app's assistant uses it. Enter to skip: the assistant then answers 503 until it is set.`, 'OpenRouter');
    cfg.openrouterKey = await answer(p.password({ message: 'OpenRouter API key' }));
  }
  if (cfg.openrouterKey && !cfg.openrouterModel) {
    p.note(`Any model with tool calls, from ${link('https://openrouter.ai/models')}\n(copy its id, like google/gemini-2.5-flash).`, 'OpenRouter model');
    cfg.openrouterModel = await answer(p.text({ message: 'OpenRouter model', validate: required('A model') }));
  }

  if (!cfg.queueTopic) {
    // One ntfy topic for every app's queue, so the phone subscribes once.
    const lunnaQueue = readJson(path.join(cfg.projectsDir, 'lunna', '.git', 'queue', 'config.json'), {});
    cfg.queueTopic = lunnaQueue.topic ?? `apps-${randomBytes(12).toString('hex')}`;
  }

  writeJson(CONFIG, cfg);
  await deployConfig();
  return cfg;
}

/** The Pi and Cloudflare settings scripts/gh_setup.sh reads. */
async function deployConfig() {
  const env = readEnv(DEPLOY_ENV);
  const missing = ['PI_SSH_HOST', 'CLOUDFLARE_SSH_HOSTNAME', 'TUNNEL_SERVICE_TOKEN_ID', 'TUNNEL_SERVICE_TOKEN_SECRET'].filter((k) => !env[k]);
  if (!missing.length) return env;

  p.note([
    `The deploy reaches the Pi through a Cloudflare Access service token, the same for every app.`,
    `They go in ${DEPLOY_ENV} (only you can read it).`,
    ``,
    `Service token: ${link('https://one.dash.cloudflare.com')} → Access → Service Auth → Service Tokens`,
    `(reuse the one Lunna's deploy uses if you still have it; a new one also needs`,
    `adding to the SSH application's policy).`,
  ].join('\n'), 'Pi deploy settings');
  const values = {};
  if (!env.PI_SSH_HOST) values.PI_SSH_HOST = await answer(p.text({ message: 'SSH alias of the Pi (~/.ssh/config)', defaultValue: 'focus', placeholder: 'focus' }));
  if (!env.CLOUDFLARE_SSH_HOSTNAME) values.CLOUDFLARE_SSH_HOSTNAME = await answer(p.text({ message: 'Tunnel hostname the deploy SSHes through', defaultValue: 'deploy.pietroteruya.dev', placeholder: 'deploy.pietroteruya.dev' }));
  if (!env.TUNNEL_SERVICE_TOKEN_ID) values.TUNNEL_SERVICE_TOKEN_ID = await answer(p.text({ message: 'Service token Client ID', validate: required('The Client ID') }));
  if (!env.TUNNEL_SERVICE_TOKEN_SECRET) values.TUNNEL_SERVICE_TOKEN_SECRET = await answer(p.password({ message: 'Service token Client Secret', validate: required('The secret') }));
  setEnv(DEPLOY_ENV, values);
  return readEnv(DEPLOY_ENV);
}

// ---------------------------------------------------------------------------
// The app's own answers
// ---------------------------------------------------------------------------

async function askNames(cfg) {
  p.log.step(pc.bold('The app'));
  const slug = await answer(p.text({
    message: `Name in the domain (${pc.dim(`<name>.${cfg.domain}`)})`,
    placeholder: 'voiceover',
    validate: (v) => {
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(v ?? '')) return 'Lowercase letters, digits and -, starting with a letter';
      if (fs.existsSync(path.join(APPS, `${v}.json`))) return `${v} was started before: run ./new-app --resume ${v}`;
      return undefined;
    },
  }));
  const repoDefault = slug.replace(/-/g, '_');
  const repo = await answer(p.text({
    message: `GitHub repository (${pc.dim(`${cfg.owner}/<repo>`)})`,
    placeholder: repoDefault, defaultValue: repoDefault,
    validate: (v) => {
      const name = v?.trim() || repoDefault;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Letters, digits, ., _ and -';
      if (sh('gh', ['repo', 'view', `${cfg.owner}/${name}`], { allowFail: true }).ok) return `${cfg.owner}/${name} already exists`;
      if (fs.existsSync(path.join(cfg.projectsDir, name))) return `${path.join(cfg.projectsDir, name)} already exists`;
      return undefined;
    },
  }));
  const label = await answer(p.text({
    message: 'Label (the name people read)',
    placeholder: title(repo), defaultValue: title(repo),
    validate: (v) => (/["\\]/.test(v ?? '') ? 'No quotes or backslashes' : undefined),
  }));
  const pkgDefault = repo.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'app_$1');
  const pkg = await answer(p.text({
    message: `Dart package ${pc.dim('(Enter keeps it)')}`,
    placeholder: pkgDefault, defaultValue: pkgDefault,
    validate: (v) => (/^[a-z][a-z0-9_]*$/.test(v?.trim() || pkgDefault) ? undefined : 'lowercase_with_underscores'),
  }));
  const bundle = `com.pietroid.${pkg.replace(/_/g, '')}`;
  const description = await answer(p.text({
    message: 'What is it, in one line? (for the README, AGENTS.md and the assistant)',
    placeholder: 'A voice notes app that turns rambling into tidy text.',
    validate: required('A line'),
  }));
  const visibility = await answer(p.select({
    message: 'Repository visibility',
    options: [
      { value: 'private', label: 'Private', hint: 'the review page needs GitHub Pages, which private repos only get on a paid plan' },
      { value: 'public', label: 'Public', hint: 'like Lunna; the queue only ever reads your own issues' },
    ],
  }));
  return { slug, repo, label, pkg, bundle, description, visibility, host: `${slug}.${cfg.domain}` };
}

async function askNeon(app) {
  p.log.step(pc.bold('Database (Neon)'));
  p.note([
    `1. Open ${link('https://console.neon.tech/app/projects')} → New project`,
    `   name: ${pc.bold(app.label)}   region: ${pc.bold('AWS São Paulo (sa-east-1)')}`,
    `2. It starts with a ${pc.bold('main')} branch (production).`,
    `   Branches → New branch → name it ${pc.bold('dev')}, from main (local work).`,
    `3. For each branch: Dashboard → ${pc.bold('Connect')} → pick the branch → copy the`,
    `   connection string (ends in ?sslmode=require). Show password first.`,
  ].join('\n'), 'Neon');
  app.neonMain = (await answer(p.password({ message: 'Connection string of main (production)', validate: isPostgres }))).trim();
  app.neonDev = (await answer(p.password({ message: 'Connection string of dev (local)', validate: isPostgres }))).trim();
}

async function askGoogle(app) {
  p.log.step(pc.bold('Google sign-in'));
  p.note([
    `1. ${link('https://console.cloud.google.com/projectcreate')} → project name ${pc.bold(app.label)}`,
    `2. APIs & Services → ${pc.bold('OAuth consent screen')} → Get started: app name ${pc.bold(app.label)},`,
    `   your email, External. Audience → add yourself as a test user (or publish it).`,
    `3. ${pc.bold('Clients')} → Create client → ${pc.bold('Web application')}:`,
    `   Authorized JavaScript origins:`,
    `     https://${app.host}`,
    `     http://localhost:5173`,
    `     http://localhost:3000`,
    `   Authorized redirect URIs:`,
    `     https://${app.host}/api/auth/callback/google`,
    `     http://localhost:3000/api/auth/callback/google`,
    `   → copy its Client ID and Client secret.`,
    `4. Create client → ${pc.bold('iOS')}, bundle ID ${pc.bold(app.bundle)} → copy the Client ID.`,
    `   Again for ${pc.bold(`${app.bundle}.dev`)}.`,
    `5. Android clients need your keystore's SHA-1; that is left for later (SETUP.md).`,
    ``,
    `Press Enter on any of them to skip: sign-in stays off until you run`,
    `./new-app --resume ${app.slug} with them.`,
  ].join('\n'), 'Google Cloud');
  const keep = (v, old) => v?.trim() || old || '';
  app.googleWeb = keep(await answer(p.text({ message: 'Web client ID', validate: isGoogleId(true), initialValue: app.googleWeb })), app.googleWeb);
  if (app.googleWeb) {
    app.googleSecret = keep(await answer(p.password({ message: 'Web client secret' })), app.googleSecret);
  }
  app.googleIos = keep(await answer(p.text({ message: `iOS client ID for ${app.bundle}`, validate: isGoogleId(true), initialValue: app.googleIos })), app.googleIos);
  app.googleIosDev = keep(await answer(p.text({ message: `iOS client ID for ${app.bundle}.dev`, validate: isGoogleId(true), initialValue: app.googleIosDev })), app.googleIosDev);
}

async function askPostHog(app) {
  p.log.step(pc.bold('Analytics (PostHog)'));
  p.note([
    `Optional. ${link('https://us.posthog.com')} → project switcher → New project → ${pc.bold(app.label)}`,
    `→ Settings → Project → General → copy the ${pc.bold('Project API key')} (phc_…).`,
    `In the project's settings: session replay on, canvas capture on, heatmaps`,
    `and autocapture off, error tracking on.`,
    `Enter to skip: nothing is sent until a key is set.`,
  ].join('\n'), 'PostHog');
  app.posthog = (await answer(p.text({ message: 'PostHog project key', validate: (v) => (!v?.trim() || /^phc_[A-Za-z0-9]+$/.test(v.trim()) ? undefined : 'Starts with phc_') })))?.trim() ?? '';
}

const googleReady = (app) => Boolean(app.googleWeb && app.googleSecret);

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

function copyTemplate(app) {
  const files = sh('git', ['ls-files', '-co', '--exclude-standard'], { cwd: TEMPLATE }).out.split('\n')
    .filter((f) => f && !NOT_COPIED.some((re) => re.test(f)) && fs.existsSync(path.join(TEMPLATE, f)));
  fs.mkdirSync(app.dir, { recursive: true });
  for (const f of files) {
    const to = path.join(app.dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, f), to);
    fs.chmodSync(to, fs.statSync(path.join(TEMPLATE, f)).mode);
    // What only the template's own README says about the template.
    if (f === 'README.md') {
      fs.writeFileSync(to, fs.readFileSync(to, 'utf8').replace(/<!-- template-only -->[\s\S]*?<!-- \/template-only -->\n*/g, ''));
    }
  }
  return files.length;
}

function claudePrompt(app) {
  return `You are setting up a new app, made from a copy of the app template, in this directory. Work unattended and do exactly this:

1. Rename it: run
   node scripts/rename.mjs --slug ${app.slug} --package ${app.pkg} --label "${app.label}" --bundle ${app.bundle}
2. Search the tree (skip node_modules, .dart_tool, build, Pods) for any leftover "apptemplate", "app_template", "App Template" or "appTemplate" and fix each to the new names (the script prints what it changed).
3. Describe the app, which is: "${app.description}"
   - README.md: the line under the title.
   - AGENTS.md: the first sentence under "## Project" (keep the rest of the paragraph).
   - server/src/assistant/assistant.service.ts: rewrite systemPrompt so the assistant knows which app it serves and what the app is for. In Brazilian Portuguese, short; keep the function's signature and the user's name line.
4. Server: cd server && npm ci && npx eslint "src/**/*.ts" && npx tsc --noEmit -p tsconfig.json && npm test
5. App: cd app && flutter pub get && (cd packages/l10n && flutter gen-l10n) && flutter analyze lib test packages/*/lib packages/*/test && flutter test, then flutter test inside each app/packages/* that has a test/ folder.
6. If anything fails, fix the cause (never weaken a test) and run it again until all of it is green.

Rules: no git or gh commands (git is not set up yet, on purpose). Do not create or edit any env file (server/.env*, app/env/*.json). Do not change the design (colours, fonts, icons): the user restyles it later with /design-system. Keep your messages short.

End your final message with exactly one line: SETUP_OK, or SETUP_FAILED: <the reason>.`;
}

async function runClaude(app) {
  const args = [
    '-p', claudePrompt(app),
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(flutter:*)', 'Bash(dart:*)',
    'Bash(cd:*)', 'Bash(ls:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
    '--disallowedTools', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(rm:*)',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: app.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let result = null;
    const show = (icon, text) => console.log(`${pc.gray('│')}  ${icon} ${text}`);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') {
              const input = block.input ?? {};
              const what = input.command ?? input.file_path ?? input.pattern ?? '';
              show(pc.cyan('›'), `${pc.bold(block.name)} ${pc.dim(String(what).replace(app.dir + '/', '').split('\n')[0].slice(0, 110))}`);
            } else if (block.type === 'text' && block.text.trim()) {
              for (const l of block.text.trim().split('\n').slice(0, 4)) show(pc.magenta('✻'), pc.dim(l.slice(0, 120)));
            }
          }
        } else if (event.type === 'result') {
          result = event;
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      const text = result?.result ?? '';
      const ok = code === 0 && !result?.is_error && /SETUP_OK\s*$/.test(text.trim());
      const why = text.match(/SETUP_FAILED:\s*(.*)$/m)?.[1] ?? (stderr.trim() || text.trim().split('\n').at(-1) || `claude exited ${code}`);
      resolve({ ok, why, cost: result?.total_cost_usd, turns: result?.num_turns, ms: result?.duration_ms });
    });
  });
}

function writeEnvs(app, cfg) {
  const ids = [app.googleWeb, app.googleIos, app.googleIosDev].filter(Boolean).join(',');
  const common = {
    GOOGLE_CLIENT_IDS: ids || 'PENDING',
    GOOGLE_CLIENT_SECRET: app.googleSecret || 'PENDING',
    ALLOWED_EMAILS: cfg.emails,
    OPENROUTER_API_KEY: cfg.openrouterKey ?? '',
    OPENROUTER_MODEL: cfg.openrouterModel ?? '',
    OPENROUTER_REASONING: 'low',
  };
  app.authSecretDev ??= randomBytes(32).toString('base64');
  app.authSecretProd ??= randomBytes(32).toString('base64');

  // The local server: Neon's dev branch, sending nothing to PostHog.
  writePrivate(path.join(app.dir, 'server', '.env.local'), envFile({
    '# Written by ./new-app. See .env.example for what each one is.': '',
    PORT: 3000,
    DATABASE_URL: app.neonDev,
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: app.authSecretDev,
    TRUSTED_ORIGINS: 'http://localhost:5173',
    ...common,
    POSTHOG_KEY: '',
    POSTHOG_HOST: 'https://us.i.posthog.com',
  }));

  // Production, for /opt/<slug>/.env on the Pi (the CLI installs it there).
  app.prodEnv = envFile({
    '# The server\'s production settings, installed by ./new-app (scripts/pi_setup.sh).': '',
    DATABASE_URL: app.neonMain,
    BETTER_AUTH_URL: `https://${app.host}`,
    BETTER_AUTH_SECRET: app.authSecretProd,
    ...common,
    POSTHOG_KEY: app.posthog ?? '',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    APP_TIMEZONE: 'America/Sao_Paulo',
  });

  const appEnv = (flavor, api, ios, posthog) => `${JSON.stringify({
    API_BASE_URL: api,
    GOOGLE_WEB_CLIENT_ID: app.googleWeb ?? '',
    GOOGLE_IOS_CLIENT_ID: ios ?? '',
    POSTHOG_KEY: posthog,
    POSTHOG_HOST: 'https://us.i.posthog.com',
    FLAVOR: flavor,
  }, null, 2)}\n`;
  writePrivate(path.join(app.dir, 'app/env/dev.json'), appEnv('dev', 'http://localhost:3000/api', app.googleIosDev, ''));
  writePrivate(path.join(app.dir, 'app/env/production.json'), appEnv('production', `https://${app.host}/api`, app.googleIos, app.posthog ?? ''));

  // Not secret, and committed: the URL schemes Google Sign-In returns to.
  const xcconfig = path.join(app.dir, 'app/ios/Flutter/GoogleSignIn.xcconfig');
  let text = fs.readFileSync(xcconfig, 'utf8');
  if (app.googleIos) text = text.replace(/(\[config=\*-production\] = ).*/, `$1${reversed(app.googleIos)}`);
  if (app.googleIosDev) text = text.replace(/(\[config=\*-dev\] = ).*/, `$1${reversed(app.googleIosDev)}`);
  fs.writeFileSync(xcconfig, text);
}

/** Whether `ssh <host>` gets in, and if not, why. */
function reachPi(host) {
  const r = sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'true'], { allowFail: true });
  return r.ok ? null : (r.err.split('\n').at(-1) || 'unreachable');
}

async function piReachable(host) {
  for (;;) {
    const why = reachPi(host);
    if (!why) return true;
    p.note([
      `${pc.red('ssh ' + host)}: ${why}`,
      ``,
      `• Be on the Pi's network (home Wi-Fi).`,
      `• "No route to host" from inside VS Code or Cursor while Terminal works`,
      `  means macOS blocks that app's local network: System Settings → Privacy`,
      `  & Security → Local Network → turn it on for that app, then restart it.`,
      `  Or run ./new-app from Terminal.app.`,
    ].join('\n'), 'Cannot reach the Pi');
    const next = await answer(p.select({
      message: 'What now?',
      options: [
        { value: 'retry', label: 'Try again' },
        { value: 'skip', label: 'Skip the Pi for now', hint: 'the app is created and pushed, but not deployed until ./new-app --resume' },
      ],
    }));
    if (next === 'skip') return false;
  }
}

/** Two ports nothing on the Pi listens on or has claimed in an /opt/<app>/.env. */
function pickPorts(host, app) {
  const out = sh('ssh', [host, `ss -Hltn | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\\1/'; grep -hE '^[A-Z_]*PORT=' /opt/*/.env 2>/dev/null | grep -v '^#' | cut -d= -f2; grep -hE '^(WEB|BACKEND)_PORT=' /opt/${app.slug}/.env 2>/dev/null | sed 's/^/OWN_/'`]).out;
  const own = Object.fromEntries(out.split('\n').filter((l) => l.startsWith('OWN_')).map((l) => l.slice(4).split('=')));
  const used = new Set(out.split('\n').filter((l) => /^\d+$/.test(l)).map(Number));
  const free = (from) => { let port = from; while (used.has(port)) port++; used.add(port); return port; };
  // Running again keeps the ports this app already has.
  return {
    web: Number(own.WEB_PORT) || free(8100),
    backend: Number(own.BACKEND_PORT) || free(3100),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: ./new-app [--resume <slug>]');
    return;
  }
  const resumeAt = argv.indexOf('--resume');
  const resumeSlug = resumeAt >= 0 ? argv[resumeAt + 1] : null;
  if (resumeAt >= 0 && !resumeSlug) bail('usage: ./new-app --resume <slug>');

  console.log();
  p.intro(pc.inverse(' new app '));

  // Tools first, so nothing is asked for a run that cannot finish.
  const missingTools = ['git', 'gh', 'node', 'npm', 'flutter', 'claude', 'ssh'].filter((t) => !has(t));
  if (missingTools.length) bail(`Missing: ${missingTools.join(', ')}. Install them and run again.`);
  if (!sh('gh', ['auth', 'status'], { allowFail: true }).ok) bail('GitHub CLI is not signed in: run `gh auth login`, then again.');
  const gitName = sh('git', ['config', 'user.name'], { allowFail: true }).out;
  const gitEmail = sh('git', ['config', 'user.email'], { allowFail: true }).out;
  if (!gitName || !gitEmail) bail('git has no user.name / user.email: set them, so the commits are yours.');

  const cfg = await sharedConfig();
  const deploy = readEnv(DEPLOY_ENV);

  let app;
  const statePath = (slug) => path.join(APPS, `${slug}.json`);
  if (resumeSlug) {
    app = readJson(statePath(resumeSlug), null);
    if (!app) bail(`Nothing started for ${resumeSlug} (no ${statePath(resumeSlug)}).`);
    p.log.info(`Resuming ${pc.bold(app.label)} (${app.dir})`);
    if (!googleReady(app) || !app.googleIos || !app.googleIosDev) {
      if (await answer(p.confirm({ message: 'Fill in the Google clients that were skipped?' }))) {
        const before = JSON.stringify([app.googleWeb, app.googleSecret, app.googleIos, app.googleIosDev]);
        await askGoogle(app);
        if (JSON.stringify([app.googleWeb, app.googleSecret, app.googleIos, app.googleIosDev]) !== before) {
          // New clients change the env files, the xcconfig and the Pi's .env.
          app.done.env = false; app.done.pi = false; app.googleChanged = true;
        }
      }
    }
  } else {
    app = await askNames(cfg);
    app.dir = path.join(cfg.projectsDir, app.repo);
    app.done = {};
    writeJson(statePath(app.slug), app);
    await askNeon(app);
    writeJson(statePath(app.slug), app);
    await askGoogle(app);
    writeJson(statePath(app.slug), app);
    await askPostHog(app);
    writeJson(statePath(app.slug), app);
  }
  const save = () => writeJson(statePath(app.slug), app);
  const full = `${cfg.owner}/${app.repo}`;

  const plan = [
    ['copy', `Copy the template to ${app.dir}`],
    ['claude', 'Claude renames it, describes it, installs and checks everything'],
    ['env', 'Write the local and production env files'],
    ['git', `Commit as ${gitName} <${gitEmail}>`],
    ['repo', `Create github.com/${full} (${app.visibility})`],
    ['pi', `Prepare the Pi: /opt/${app.slug}, its .env, https://${app.host}`],
    ['secrets', 'Set the deploy secrets and variables on GitHub'],
    ['push', 'Push to main (the first deploy starts)'],
    ['queue', 'Turn the issue queue on (labels, LaunchAgent, phone pushes)'],
  ];
  p.note(plan.map(([id, what], i) => `${app.done[id] ? pc.green('✓') : pc.dim(String(i + 1))}  ${app.done[id] ? pc.dim(what) : what}`).join('\n'), `${app.label} · ${app.slug} · ${app.pkg} · ${app.bundle}`);
  if (!(await answer(p.confirm({ message: 'Go?' })))) bail('Nothing done.');

  const step = async (id, fn) => {
    if (app.done[id]) return;
    const what = plan.find(([k]) => k === id)[1];
    p.log.step(pc.bold(what));
    const result = await fn();
    if (result === 'skipped') return;
    app.done[id] = true;
    save();
  };

  await step('copy', () => {
    const n = copyTemplate(app);
    p.log.success(`${n} files`);
  });

  await step('claude', async () => {
    p.log.message(pc.dim('A headless Claude Code session: it edits files and runs the checks, but cannot use git, gh or ssh.'));
    const r = await runClaude(app);
    const meta = [r.turns && `${r.turns} turns`, r.ms && `${Math.round(r.ms / 1000)}s`, r.cost && `$${r.cost.toFixed(2)}`].filter(Boolean).join(' · ');
    if (!r.ok) bail(`Claude could not finish: ${r.why}\nFix it in ${app.dir}, then ./new-app --resume ${app.slug}`);
    // Its own copy of the rename is spent; a later rename would start from the new names.
    fs.rmSync(path.join(app.dir, 'scripts/rename.mjs'), { force: true });
    p.log.success(`Renamed and green${meta ? pc.dim(` (${meta})`) : ''}`);
  });

  await step('env', () => {
    writeEnvs(app, cfg);
    p.log.success([
      'server/.env.local           Neon dev, localhost',
      'app/env/dev.json            localhost:3000',
      'app/env/production.json     ' + `https://${app.host}`,
      'ios GoogleSignIn.xcconfig   ' + (app.googleIos || app.googleIosDev ? 'the iOS clients' : pc.yellow('pending (no iOS clients yet)')),
      'production .env             for the Pi, installed in a later step',
    ].join('\n'));
    if (!googleReady(app)) p.log.warn('No Google web client yet: the server boots, but sign-in fails until ./new-app --resume ' + app.slug);
  });

  await step('git', () => {
    sh('git', ['init', '-q', '-b', 'main'], { cwd: app.dir });
    sh('git', ['add', '-A'], { cwd: app.dir });
    sh('git', ['commit', '-q', '-m', `Create ${app.label} from the app template\n\n${app.description}`], { cwd: app.dir });
    p.log.success(sh('git', ['log', '--oneline', '-1'], { cwd: app.dir }).out);
  });

  // A later run that changed committed files (the iOS clients) commits them.
  if (app.done.git && sh('git', ['status', '--porcelain'], { cwd: app.dir }).out) {
    sh('git', ['add', '-A'], { cwd: app.dir });
    sh('git', ['commit', '-q', '-m', 'Add the Google iOS clients'], { cwd: app.dir });
    p.log.success('Committed the new Google iOS clients');
    if (app.done.push) app.pushAgain = true;
  }

  await step('repo', () => {
    sh('gh', ['repo', 'create', full, `--${app.visibility}`, '--source', app.dir, '--remote', 'origin', '--description', app.description]);
    p.log.success(link(`https://github.com/${full}`));
  });

  let piOk = app.done.pi;
  await step('pi', async () => {
    const host = deploy.PI_SSH_HOST || 'focus';
    if (!(await piReachable(host))) {
      p.log.warn('Skipped: run ./new-app --resume ' + app.slug + ' from home to deploy.');
      return 'skipped';
    }
    app.ports ??= pickPorts(host, app);
    save();
    p.log.message(`web ${pc.bold(app.ports.web)} → https://${app.host}   backend ${pc.bold(app.ports.backend)} (loopback)`);
    // The production env goes over scp and straight into /opt/<slug>/.env.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'new-app-'));
    const envName = `${app.slug}.server.env`;
    writePrivate(path.join(tmp, envName), app.prodEnv ?? (writeEnvs(app, cfg), app.prodEnv));
    try {
      sh('scp', ['-q', path.join(app.dir, 'scripts/pi_setup.sh'), path.join(app.dir, 'scripts/cloudflare_add_domain.sh'), path.join(tmp, envName), `${host}:`]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    p.log.message(pc.dim('On the Pi (sudo may ask for its password):'));
    const code = await live('ssh', ['-t', host, `./pi_setup.sh ${app.slug} ${app.ports.web} ${app.ports.backend} ${app.host} ${envName}`]);
    if (code !== 0) bail(`pi_setup.sh failed on the Pi. Fix what it said, then ./new-app --resume ${app.slug}`);
    delete app.prodEnv;
    piOk = true;
  });

  await step('secrets', async () => {
    if (!piOk) { p.log.warn('Skipped until the Pi is set up.'); return 'skipped'; }
    const r = await streamed(path.join(app.dir, 'scripts/gh_setup.sh'), [full], { cwd: app.dir, env: { PI_DEPLOY_CONFIG: DEPLOY_ENV } });
    if (r.code !== 0) bail(`scripts/gh_setup.sh failed. Fix it, then ./new-app --resume ${app.slug}`);
    if (app.posthog) sh('gh', ['variable', 'set', 'POSTHOG_KEY', '-R', full, '--body', app.posthog]);
    sh('gh', ['variable', 'set', 'DEPLOY', '-R', full, '--body', 'true']);
    // Already pushed on an earlier run, before the deploy could: run it now.
    if (app.done.push) app.redeploy = true;
    p.log.success('Secrets: PI_SSH_PRIVATE_KEY, TUNNEL_SERVICE_TOKEN_ID/SECRET · variables: PI_USER, CLOUDFLARE_SSH_HOSTNAME' + (app.posthog ? ', POSTHOG_KEY' : '') + ', DEPLOY');
  });

  await step('push', () => {
    sh('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: app.dir });
    p.log.success(`Pushed. ${piOk ? 'Deploying' : 'Tests only (not deployed yet)'}: ${link(`https://github.com/${full}/actions`)}`);
  });
  if (app.pushAgain || (app.done.push && app.googleChanged)) {
    sh('git', ['push', '-q'], { cwd: app.dir });
    p.log.success('Pushed the new commit');
    delete app.pushAgain; delete app.googleChanged; delete app.redeploy;
    save();
  }
  if (app.redeploy) {
    sh('gh', ['workflow', 'run', 'deploy.yml', '-R', full]);
    p.log.success(`Deploy started: ${link(`https://github.com/${full}/actions`)}`);
    delete app.redeploy;
    save();
  }

  await step('queue', async () => {
    const r = await streamed('node', ['.tool/queue.mjs', 'setup'], { cwd: app.dir, env: { QUEUE_TOPIC: cfg.queueTopic } });
    if (r.code !== 0) {
      p.log.warn(`The queue did not start: run .tool/queue setup in ${app.dir} later.`);
      return 'skipped';
    }
  });

  // What is left is the person's.
  const todo = [];
  if (!googleReady(app) || !app.googleIos || !app.googleIosDev) todo.push(`Google clients: ./new-app --resume ${app.slug}`);
  if (!piOk) todo.push(`Deploy: ./new-app --resume ${app.slug} (from the Pi's network)`);
  todo.push('Android sign-in: an Android OAuth client per package with your SHA-1 (SETUP.md §2)');
  todo.push(`After the first deploy: keep the GHCR images private (github.com/${cfg.owner}?tab=packages)`);
  p.note(todo.map((t) => `• ${t}`).join('\n'), 'Left for you');

  p.note([
    `${pc.bold('App')}       ${link(`https://${app.host}`)} ${piOk ? pc.dim('(live once the deploy finishes)') : pc.dim('(not deployed yet)')}`,
    `${pc.bold('Repo')}      ${link(`https://github.com/${full}`)}`,
    `${pc.bold('Folder')}    ${app.dir}`,
    `${pc.bold('Run it')}    cd ${app.repo}/server && npm run start:local`,
    `          cd ${app.repo}/app && flutter run -d chrome --web-port 5173 --dart-define-from-file env/dev.json`,
  ].join('\n'), app.label);

  p.outro(`Now give it its own look:  ${pc.bold(pc.cyan(`cd ${app.dir} && claude`))}  then type  ${pc.bold(pc.cyan('/design-system'))}`);
}

// Run when launched (./new-app); importing it, as a test does, runs nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    p.log.error(error.message);
    process.exit(1);
  });
}

export { copyTemplate, runClaude, writeEnvs };
