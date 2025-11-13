/**
 * Утилитарный тип, который снимает модификатор `readonly` со всех свойств типа T.
 */
export type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};
