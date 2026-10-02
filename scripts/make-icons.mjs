// Draws the DocLifts icon (0.5.5) and writes it to static/: favicon.svg, and
// the PNGs the web manifest and iOS ask for. Shapes only, no text, so it
// renders the same everywhere. The dumbbell sits inside the middle 60%, the
// safe zone of a maskable icon. Rerun after changing the drawing:
//   node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const BG = '#4f46e5';
const FG = '#ffffff';

/** The 512x512 drawing; `round` gives the favicon its rounded corners. */
const svg = (
	round
) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" rx="${round ? 112 : 0}" fill="${BG}"/>
<rect x="150" y="244" width="212" height="24" rx="6" fill="${FG}"/>
<rect x="150" y="176" width="40" height="160" rx="12" fill="${FG}"/>
<rect x="322" y="176" width="40" height="160" rx="12" fill="${FG}"/>
<rect x="114" y="206" width="28" height="100" rx="10" fill="${FG}"/>
<rect x="370" y="206" width="28" height="100" rx="10" fill="${FG}"/>
</svg>
`;

writeFileSync('static/favicon.svg', svg(true));
const square = Buffer.from(svg(false));
for (const [file, size] of [
	['static/icon-192.png', 192],
	['static/icon-512.png', 512],
	// iOS rounds the corners itself and shows transparency as black: square, opaque.
	['static/apple-touch-icon.png', 180]
]) {
	await sharp(square).resize(size, size).flatten({ background: BG }).png().toFile(file);
	console.log(file, size);
}
