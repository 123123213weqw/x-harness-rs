# Third-party notices

## DeepSeek Harness web UI

The initial web UI in `ui/` is derived from DeepSeek Harness:

- Source: https://github.com/deepseek-ai/deepseek-harness
- License: MIT
- Copyright (c) 2026 DeepSeek

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ZCode terminal pane and task list

The Web terminal dock's tab model, dock layout and CSS-token theme resolution
in `ui/plugins/@xlang/xharness-client-ui-terminal/client.js` are adapted from
the Apache-2.0 `zai-org/ZCode` terminal pane; the task panel's pinned section,
timeline grouping, inline rename and action menu in
`ui/plugins/@xlang/xharness-client-ui-tasks/client.js` are adapted from its
task list. The transports and the XHarness integrations are original.

- Source: https://github.com/zai-org/ZCode (packages/ui/src/Terminal.tsx,
  packages/ui/src/terminal/)
- License: Apache License 2.0

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

## xterm.js

The vendored terminal renderer at
`ui/plugins/@xlang/xharness-client-ui-terminal/vendor/xterm.js` (and its
stylesheet) is the unmodified @xterm/xterm 5.5.0 UMD build.

- Source: https://github.com/xtermjs/xterm.js
- License: MIT, see `vendor/LICENSE-xterm.txt`

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
