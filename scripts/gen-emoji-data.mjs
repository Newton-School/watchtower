#!/usr/bin/env node
// Build src/lib/emojiData.json from emoji-datasource, the data set Slack's
// emoji names come from, so the app can show `:pray:` as 🙏 and offer a picker.
//
// Usage:
//   node scripts/gen-emoji-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const source = JSON.parse(readFileSync(new URL('../node_modules/emoji-datasource/emoji.json', import.meta.url)));
const live = source.filter(emoji => !emoji.obsoleted_by).sort((a, b) => a.sort_order - b.sort_order);
const categories = [...new Set(live.map(emoji => emoji.category))];

// Each row: [unified code points, Slack short names, category index, 1 if it takes skin tones].
const emoji = live.map(entry => [
  entry.unified,
  entry.short_names,
  categories.indexOf(entry.category),
  entry.skin_variations ? 1 : 0,
]);

const out = new URL('../src/lib/emojiData.json', import.meta.url);
writeFileSync(out, `${JSON.stringify({ categories, emoji })}\n`);
console.log(`Wrote ${emoji.length} emoji in ${categories.length} categories.`);
