export type MaybePromise<T> = T | Promise<T>;
export type PromptValidation = boolean | string;

export interface PromptChoice<V> {
  name?: string;
  value: V;
  description?: string;
  short?: string;
  checked?: boolean;
  disabled?: boolean | string;
}

export interface SelectPromptConfig<V> {
  message: string;
  choices: readonly PromptChoice<V>[];
  default?: V;
  pageSize?: number;
  loop?: boolean;
}

export interface CheckboxPromptConfig<V> extends SelectPromptConfig<V> {
  validate?: (values: readonly V[]) => MaybePromise<PromptValidation>;
}

export interface SearchPromptConfig<V> {
  message: string;
  source: (term?: string) => MaybePromise<readonly PromptChoice<V>[]>;
  default?: V;
  pageSize?: number;
  loop?: boolean;
}

export interface InputPromptConfig {
  message: string;
  default?: string;
  validate?: (value: string) => MaybePromise<PromptValidation>;
}

export interface ConfirmPromptConfig {
  message: string;
  default?: boolean;
}

export interface PasswordPromptConfig {
  message: string;
  validate?: (value: string) => MaybePromise<PromptValidation>;
  signal?: AbortSignal;
}

export type SelectPrompt = <V>(config: SelectPromptConfig<V>) => Promise<V>;
export type CheckboxPrompt = <V>(config: CheckboxPromptConfig<V>) => Promise<V[]>;
export type SearchPrompt = <V>(config: SearchPromptConfig<V>) => Promise<V>;
export type InputPrompt = (config: InputPromptConfig) => Promise<string>;
export type ConfirmPrompt = (config: ConfirmPromptConfig) => Promise<boolean>;
export type PasswordPrompt = (config: PasswordPromptConfig) => Promise<string>;

export interface KeypressPromptConfig {
  signal?: AbortSignal;
}

export interface DirectoryPromptConfig {
  message: string;
  cwd: string;
  default?: string;
  home?: string;
  cache?: import("./directory-picker.js").DirectoryListingCache;
}
