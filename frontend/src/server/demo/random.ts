/**
 * Детерминированный генератор случайных чисел (mulberry32): одно зерно —
 * одни и те же люди, машины и заказы. Зерно генератор берёт от даты сборки
 * витрины, поэтому каждый день данные немного другие, а внутри дня — одни и
 * те же при повторной сборке.
 */
export class DemoRandom {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number) {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const total = items.reduce((sum, item) => sum + weight(item), 0);
    let roll = this.next() * total;
    for (const item of items) {
      roll -= weight(item);
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  /** Нормальное распределение (Бокс — Мюллер), обрезанное до [min, max]. */
  normal(mean: number, deviation: number, min: number, max: number) {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    const value = mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(max, Math.max(min, value));
  }

  /** Число событий Пуассона со средним `mean`. */
  poisson(mean: number) {
    if (mean <= 0) return 0;
    const limit = Math.exp(-mean);
    let product = this.next();
    let count = 0;
    while (product > limit) {
      product *= this.next();
      count += 1;
    }
    return count;
  }

  shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }

  uuid() {
    const hex = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}

function hashSeed(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
