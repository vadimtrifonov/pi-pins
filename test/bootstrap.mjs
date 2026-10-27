// Reproduce Pi's shared-core module aliases for a standalone Node test process.
import { registerHooks } from 'node:module';
const aliases=new Map(['@earendil-works/pi-coding-agent','@earendil-works/pi-tui','@earendil-works/pi-ai'].map(name=>[name,import.meta.resolve(name)]));
registerHooks({resolve(specifier,context,next){
  const url=aliases.get(specifier);
  return url ? {url,shortCircuit:true} : next(specifier,context);
}});
// Match the application's action bindings as well as the TUI defaults.
const {KeybindingsManager}=await import(new URL('./core/keybindings.js',import.meta.resolve('@earendil-works/pi-coding-agent')));
const {setKeybindings}=await import('@earendil-works/pi-tui');
setKeybindings(new KeybindingsManager());
