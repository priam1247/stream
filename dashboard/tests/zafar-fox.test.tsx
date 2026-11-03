import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ZafarFox } from '../components/zafar-fox';

afterEach(cleanup);

describe('zAfAr fox mascot', () => {
  it('renders an original decorative ink fox with accessible hiding', () => {
    const { container } = render(<ZafarFox />);
    const fox = container.querySelector('.zafar-fox');
    expect(fox?.getAttribute('aria-hidden')).toBe('true');
    expect(fox?.querySelector('svg path')).toBeTruthy();
    expect(fox?.querySelector('img, video, canvas')).toBeNull();
  });

  it('supports the compact size in keyboard-constrained layouts', () => {
    const { container } = render(<><ZafarFox /><ZafarFox compact /></>);
    const mascots = container.querySelectorAll('.zafar-fox');
    expect(mascots).toHaveLength(2);
    expect(mascots[1].classList.contains('zafar-fox--compact')).toBe(true);
  });
});
