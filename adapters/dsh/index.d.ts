import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-memory-backpack': { kind: 'agent-memory-backpack'; form: 'instructions' }
  }
}

export declare const name: 'agent-memory-backpack'
export declare const inject: ['tools']
export declare function apply(ctx: Context): Promise<void>
declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply }
export default plugin
