#!/usr/bin/env node
/**
 * Dev-host installer (amux form): junction ~/.agents/skills/ukp -> the
 * in-repo skill face at ukp/skills/ukp, and
 * <home>/node_modules/@catheadowl/ukp -> this package dir, so both the
 * agent face and the global bin follow the working tree (a plain install
 * snapshots instead — the command stops seeing source edits; same lesson
 * as amux 2026-10-19). Zero deps, node-run; run after syncs or a fresh
 * `bun install -g` overwrote the links. Idempotent; a real directory in
 * the way (install snapshot / pre-adoption copy) is renamed aside, never
 * deleted. Not shipped (package "files" keeps scripts/ out).
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

function junction(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  let st = null;
  try { st = lstatSync(dst); } catch {} // absent — the one creatable state
  if (!st) {
    symlinkSync(src, dst, 'junction'); // junction: no admin/developer mode needed
    console.log(`junctioned: ${dst} -> ${src}`);
    return;
  }
  if (st.isSymbolicLink()) {
    const cur = readlinkSync(dst);
    if (resolve(dirname(dst), cur) === src) {
      console.log(`already in place: ${dst} -> ${src}`);
      return;
    }
  }
  const aside = `${dst}.pre-junction-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  renameSync(dst, aside);
  symlinkSync(src, dst, 'junction');
  console.log(
    `replaced ${st.isSymbolicLink() ? 'foreign link' : 'real directory'}: ${dst} -> ${src} (old copy aside at ${aside})`,
  );
}

junction(join(pkgDir, 'skills', 'ukp'), join(homedir(), '.agents', 'skills', 'ukp'));
const [scope, name] = pkg.name.split('/');
junction(pkgDir, join(homedir(), 'node_modules', scope, name));
