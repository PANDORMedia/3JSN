import { ident, lexer, parse, walk } from 'css-tree';
import { BuildError } from './contract.mjs';

export const WEB_FONT_CAPABILITY = 'dom-package-fonts-v1';
const unsupported = message => { throw new BuildError('FONT_NATIVE_UNSUPPORTED', message); };

export function validateWebFontRuntime(description) {
  if (!Array.isArray(description.capabilities) || !description.capabilities.includes(WEB_FONT_CAPABILITY)) {
    throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied DOM player must advertise ${WEB_FONT_CAPABILITY}.`);
  }
}

/** Admission for the experimental package-font provider; localization itself is independent. */
export function validateWebFontRequirements(requirement) {
  if (requirement.conditions.length) unsupported('Conditional font-face loading is not yet admitted by the native package-font profile.');
  if (requirement.sources.some(source => source.type === 'local')) unsupported('local() font selection is not supported; the build will not remove or replace it.');
  if (requirement.sources.length !== 1) unsupported('Multiple font sources require native failure/fallback semantics that are not implemented.');
  const allowed = new Set(['font-family', 'src', 'font-style', 'font-weight', 'font-stretch', 'unicode-range', 'font-display']);
  for (const descriptor of requirement.descriptors) {
    if (!allowed.has(descriptor.name)) unsupported(`Font descriptor ${descriptor.name} requires additional native support.`);
    const ast = parse(descriptor.value, { context: 'value' });
    if (lexer.matchAtruleDescriptor('font-face', descriptor.name, ast).error) unsupported(`Invalid or unsupported ${descriptor.name} descriptor.`);
    if (descriptor.name === 'font-style' && !['normal', 'italic'].includes(descriptor.value.toLowerCase())) unsupported('Only normal and italic font-face styles are admitted.');
    if (descriptor.name === 'font-stretch' && descriptor.value.toLowerCase() !== 'normal'
      && !(ast.children.size === 1 && ast.children.first.type === 'Percentage' && Number(ast.children.first.value) === 100)) unsupported('Font stretch matching outside normal/100% remains unverified.');
    if (descriptor.name === 'src') walk(ast, node => {
      if (node.type !== 'Function') return;
      const name = ident.decode(node.name).toLowerCase();
      if (name === 'local' || name === 'tech') unsupported(`${name}() font sources require additional native support.`);
      if (name === 'format') {
        const values = [...node.children];
        const format = values.length === 1 ? (values[0].type === 'String' ? values[0].value : values[0].name) : undefined;
        if (!['woff2', 'woff', 'truetype', 'opentype'].includes(format?.toLowerCase())) unsupported('The native package-font profile supports WOFF2, WOFF, TrueType and OpenType formats.');
      }
    });
  }
}
