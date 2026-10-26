interface Greeter {
  prefix: string;
}

const greeter: Greeter = { prefix: 'hello' };

export function greet(name: string): string {
  return `${greeter.prefix} ${name}`;
}
