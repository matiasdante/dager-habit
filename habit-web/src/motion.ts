import { waapi } from 'animejs/waapi';

type EnterTargets = HTMLElement | HTMLElement[] | NodeListOf<HTMLElement> | null | undefined;
interface EnterOptions {
  transform: string[];
  opacity?: number[];
  duration: number;
  delay?: Parameters<typeof waapi.animate>[1]['delay'];
}

export const easeOut = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export const slideIn = {
  opacity: [0.68, 1],
  transform: ['translateY(12px)', 'translateY(0)'],
  duration: 280,
};

export function enter(elements: EnterTargets, options: EnterOptions = slideIn) {
  if (reducedMotion.matches || !elements || (!(elements instanceof HTMLElement) && !elements.length)) return;
  return waapi.animate(elements, { ...options, ease: easeOut });
}
