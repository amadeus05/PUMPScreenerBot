import 'reflect-metadata';

const INJECTABLE_METADATA_KEY = 'injectable';
const INJECT_METADATA_KEY = 'inject';

export function Injectable(): ClassDecorator {
  return (target: any) => {
    Reflect.defineMetadata(INJECTABLE_METADATA_KEY, true, target);
  };
}

export function Inject(token: string): ParameterDecorator {
  return (target: any, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existingInjections = Reflect.getMetadata(INJECT_METADATA_KEY, target) || [];
    existingInjections.push({ index: parameterIndex, token });
    Reflect.defineMetadata(INJECT_METADATA_KEY, existingInjections, target);
  };
}

export function isInjectable(target: any): boolean {
  return Reflect.getMetadata(INJECTABLE_METADATA_KEY, target) === true;
}

export function getInjectedParams(target: any): Array<{ index: number; token: string }> {
  return Reflect.getMetadata(INJECT_METADATA_KEY, target) || [];
}
