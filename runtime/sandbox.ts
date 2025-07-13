// File: /runtime/sandbox.ts
import vm from "vm";
import "ses"; // ESM style
lockdown();

export class Sandbox {
  constructor(
    private sbx: {
      distributed: {
        process: (
          data: any,
          strategy: string,
          jobCode: string,
          options?: any
        ) => Promise<any>;
        strategies?: Map<
          string,
          { merge: (results: any[], options?: any) => any }
        >;
      };
    }
  ) {}

  static run(code: string, context: Record<string, any>): any {
    try {
      // Create a safe context proxy
      const safeContext = new Proxy(context, {
        get(target, prop) {
          return target[prop as string];
        },
        set() {
          return false;
        },
      });

      // Create string for destructuring context
      const contextKeys = Object.keys(context);
      const destructureVars =
        contextKeys.length > 0
          ? `const { ${contextKeys.join(", ")} } = context;`
          : "";

      const script = new vm.Script(`
        "use strict";
        ${destructureVars}
        ${code}
      `);
      const sandbox: any = { context: safeContext };
      const vmcontext: any = vm.createContext(sandbox);
      return script.runInContext(vmcontext);
    } catch (err: any) {
      throw new Error(`Sandbox failed: ${err.message}`);
    }
  }

  async split(data: any, strategy: string, options?: any): Promise<any[]> {
    return this.sbx.distributed.process(data, strategy, "", options);
  }

  async merge(results: any[], strategy: string, options?: any): Promise<any> {
    const strategyObj = this.sbx.distributed.strategies?.get(strategy);
    if (!strategyObj) throw new Error(`Unknown merge strategy: ${strategy}`);
    return strategyObj.merge(results, options);
  }
}
