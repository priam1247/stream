import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ZafarRobot } from '../components/zafar-robot';

afterEach(cleanup);

describe('zAfAr robot', () => {
  it('renders a decorative front, back and chassis without external assets', () => {
    const { container } = render(<ZafarRobot />);
    const robot = container.querySelector('.zafar-robot');
    expect(robot?.getAttribute('aria-hidden')).toBe('true');
    expect(robot?.querySelectorAll('.zafar-robot__face')).toHaveLength(2);
    expect(robot?.querySelectorAll('.zafar-robot__side')).toHaveLength(4);
    expect(robot?.querySelector('.zafar-robot__turner')).toBeTruthy();
    expect(robot?.querySelector('img, video, canvas')).toBeNull();
  });

  it('keeps the turn continuous and disables every animated part for reduced motion', () => {
    const css = postcss.parse(readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8'));
    let turning = false;
    let reduced = false;
    css.walkRules('.zafar-robot__turner', (rule) => {
      rule.walkDecls('animation', (decl) => { if (/zafar-turn.*infinite/.test(decl.value)) turning = true; });
    });
    css.walkAtRules('media', (media) => {
      if (!media.params.includes('prefers-reduced-motion: reduce')) return;
      media.walkRules((rule) => {
        if (!rule.selectors.includes('.zafar-robot *')) return;
        rule.walkDecls('animation', (decl) => { if (decl.value === 'none' && decl.important) reduced = true; });
      });
    });
    expect(turning).toBe(true);
    expect(reduced).toBe(true);
  });

  it('keeps the keyboard-compact size and unique SVG paint IDs for multiple robots', () => {
    const { container } = render(<><ZafarRobot /><ZafarRobot compact /></>);
    const robots = container.querySelectorAll('.zafar-robot');
    expect(robots).toHaveLength(2);
    expect(robots[1].classList.contains('zafar-robot--compact')).toBe(true);
    const ids = Array.from(container.querySelectorAll('linearGradient, clipPath'), (element) => element.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const element of Array.from(container.querySelectorAll('[fill^="url(#"], [clip-path^="url(#"]'))) {
      const reference = (element.getAttribute('fill') || element.getAttribute('clip-path') || '').slice(5, -1);
      expect(ids).toContain(reference);
    }
  });
});
