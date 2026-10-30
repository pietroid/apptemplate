#!/usr/bin/env node
// Renames a fresh copy of the template to a new app. Run once, from the
// copy's root, before anything else; the setup CLI has Claude run it.
//
//   node scripts/rename.mjs --slug voiceover --package voice_over --label "Voice Over"
//
// The template spells each name it carries in its own way, so every
// replacement is exact and none can catch another:
//
//   com.pietroid.apptemplate   the bundle / application id  -> --bundle
//   app_template               the Dart package             -> --package
//   App Template               the name people read         -> --label
//   apptemplate                the subdomain, containers, images and
//                              /opt folder on the Pi        -> --slug
//
// The bundle id defaults to com.pietroid.<package without underscores>,
// since iOS allows no underscore in one.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    package: { type: 'string' },
    label: { type: 'string' },
    bundle: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const slug = values.slug ?? fail('--slug is required');
const pkg = values.package ?? fail('--package is required');
const label = values.label ?? fail('--label is required');
const bundle = values.bundle ?? `com.pietroid.${pkg.replaceAll('_', '')}`;

if (!/^[a-z][a-z0-9-]*$/.test(slug)) fail('--slug: lowercase letters, digits and -');
if (!/^[a-z][a-z0-9_]*$/.test(pkg)) fail('--package: lowercase letters, digits and _');
if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(bundle)) fail('--bundle: like com.pietroid.app');
if (!label.trim() || /["\\]/.test(label)) fail('--label: no quotes or backslashes');

const root = process.cwd();
if (!fs.existsSync(path.join(root, 'app/lib/main.dart'))) {
  fail('Run this from the root of a copy of the template');
}

// Longest first, so the bundle id is never cut by the slug inside it.
const pairs = [
  ['com.pietroid.apptemplate', bundle],
  ['app_template', pkg],
  ['App Template', label],
  ['apptemplate', slug],
];

const skipDirs = new Set([
  '.git', 'node_modules', '.dart_tool', 'build', 'Pods', 'dist', '.pglite',
  'ephemeral', '.symlinks', 'coverage', 'cli',
]);
const binary = /\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?|jar|zip|keystore|jks)$/i;

let changed = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full);
      continue;
    }
    if (!entry.isFile() || binary.test(entry.name)) continue;
    if (full === path.join(root, 'scripts/rename.mjs')) continue;

    const before = fs.readFileSync(full, 'utf8');
    let after = before;
    for (const [from, to] of pairs) after = after.replaceAll(from, to);
    if (after !== before) {
      changed++;
      console.log(`  ${path.relative(root, full)}`);
      if (!values['dry-run']) fs.writeFileSync(full, after);
    }
  }
}
walk(root);

// Kotlin keeps the package in its folders too.
const kotlin = path.join(root, 'app/android/app/src/main/kotlin');
const from = path.join(kotlin, 'com/pietroid/apptemplate');
const to = path.join(kotlin, ...bundle.split('.'));
if (fs.existsSync(from) && from !== to && !values['dry-run']) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from)) {
    fs.renameSync(path.join(from, file), path.join(to, file));
  }
  fs.rmSync(from, { recursive: true });
  console.log(`  moved MainActivity to ${path.relative(root, to)}`);
}

// The package's new name sorts elsewhere among the imports (app_template
// came before app_ui; voice_over comes after), so the imports are put back
// in order, as the analyzer wants them.
if (!values['dry-run']) {
  const app = path.join(root, 'app');
  const run = (cmd, args) =>
    spawnSync(cmd, args, { cwd: app, stdio: 'ignore' }).status === 0;
  if (run('flutter', ['pub', 'get']) &&
      run('dart', ['fix', '--apply', '--code=directives_ordering'])) {
    console.log('  sorted the imports (dart fix)');
  } else {
    console.log('  could not sort the imports: run `dart fix --apply --code=directives_ordering` in app/');
  }
}

console.log(
  `${values['dry-run'] ? 'Would rename' : 'Renamed'} ${changed} files: ` +
    `${slug} · ${pkg} · ${label} · ${bundle}`,
);
