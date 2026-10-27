import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sanitizeTerminalText} from '../src/terminal-text.ts';

test('terminal text loses every control-sequence family, including unfinished ones, but keeps ordinary Unicode',()=>{
 const cases=[
  ['A\x1b[2JB','AB'],['A\x9b2JB','AB'],                                    // CSI, ESC and C1 forms
  ['A\x1b]52;c;PAYLOAD\x07B','AB'],['A\x1b]52;c;PAYLOAD\x1b\\B','AB'],      // OSC ends at BEL or ST
  ['A\x9d52;c;PAYLOAD\x9cB','AB'],
  ['A\x1bPone\x07two\x1b\\B','AB'],['A\x90PAYLOAD\x9cB','AB'],              // DCS ignores BEL
  ['A\x1b^PAYLOAD\x1b\\B','AB'],['A\x9ePAYLOAD\x9cB','AB'],                 // PM, APC
  ['A\x1b_PAYLOAD\x1b\\B','AB'],['A\x9fPAYLOAD\x9cB','AB'],
  ['A\x1b(0B','AB'],['A\x1b\x01B','AB'],['A\x1b(','A('],                   // generic ESC; malformed loses ESC only
  ['A\x1b[31;','A'],['A\x1b]52;c;PAYLOAD','A'],['A\x1bPPAYLOAD','A'],      // unfinished CSI/OSC/DCS hide the rest
  ['A\tB\nC\rD\x85E\u2028F\u2029G','A B C D E F G'],
  ['A\x00\x07\x7f\x80B','AB'],['A\u202eB\u2066C\u2069\u200f\u061c','ABC'],
  ['abc\u200c\u200d 👩‍💻 𝄞','abc\u200c\u200d 👩‍💻 𝄞'],
 ];
 for(const [input,expected] of cases)assert.equal(sanitizeTerminalText(input),expected,JSON.stringify(input));
});
