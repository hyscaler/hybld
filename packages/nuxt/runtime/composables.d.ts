import type { AsyncData } from "nuxt/app";

export declare function useHybldData<T = any>(
  pageType: string,
  ref?: { slug?: string; id?: string | number; page?: number }
): AsyncData<T, Error | null>;
