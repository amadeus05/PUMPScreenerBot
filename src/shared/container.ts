import { isInjectable, getInjectedParams } from './decorators';

type Token = string | Function;
type FactoryFunction<T> = () => T;

interface Binding {
  token: Token;
  factory: FactoryFunction<any>;
  singleton: boolean;
  instance?: any;
}

export class DIContainer {
  private bindings: Map<Token, Binding> = new Map();
  private static instance: DIContainer;

  static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
    }
    return DIContainer.instance;
  }

  bind<T>(token: Token, factory: FactoryFunction<T>, singleton: boolean = true): void {
    this.bindings.set(token, { token, factory, singleton });
  }

  bindClass<T>(
    token: Token,
    constructor: new (...args: any[]) => T,
    singleton: boolean = true,
  ): void {
    this.bind(
      token,
      () => {
        const paramTypes = getInjectedParams(constructor) || [];
        const args = paramTypes.map(({ token: paramToken }) => {
          try {
            return this.get(paramToken);
          } catch (error) {
            // If dependency is not found and it's an injectable class, try to auto-register it
            if (typeof paramToken === 'function' && isInjectable(paramToken)) {
              this.bindClass(paramToken, paramToken as new (...args: any[]) => any);
              return this.get(paramToken);
            }
            throw error;
          }
        });
        return new constructor(...args);
      },
      singleton,
    );
  }

  get<T>(token: Token): T {
    const binding = this.bindings.get(token);

    if (!binding) {
      // Auto-register injectable classes
      if (typeof token === 'function' && isInjectable(token)) {
        this.bindClass(token, token as new (...args: any[]) => T);
        return this.get(token);
      }
      throw new Error(`No binding found for token: ${token}`);
    }

    if (binding.singleton && binding.instance) {
      return binding.instance;
    }

    const instance = binding.factory();

    if (binding.singleton) {
      binding.instance = instance;
    }

    return instance;
  }

  unbind(token: Token): void {
    this.bindings.delete(token);
  }

  clear(): void {
    this.bindings.clear();
  }
}

export const container = DIContainer.getInstance();
