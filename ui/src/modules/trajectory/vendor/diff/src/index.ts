/* See LICENSE file for terms of use */

/*
 * Text diff implementation.
 *
 * This library supports the following APIs:
 * Diff.diffChars: Character by character diff
 * Diff.diffWords: Word (as defined by \b regex) diff which ignores whitespace
 * Diff.diffLines: Line based diff
 *
 * Diff.diffCss: Diff targeted at CSS content
 *
 * These methods are based on the implementation proposed in
 * "An O(ND) Difference Algorithm and its Variations" (Myers, 1986).
 * http://citeseerx.ist.psu.edu/viewdoc/summary?doi=10.1.1.4.6927
 */
import Diff from './diff/base';
import {diffChars, characterDiff} from './diff/character';
import {diffWords, diffWordsWithSpace, wordDiff, wordsWithSpaceDiff} from './diff/word';
import {diffLines, diffTrimmedLines, lineDiff} from './diff/line';
import {diffSentences, sentenceDiff} from './diff/sentence';

import {diffCss, cssDiff} from './diff/css';
import {diffJson, canonicalize, jsonDiff} from './diff/json';

import {diffArrays, arrayDiff} from './diff/array';

import {applyPatch, applyPatches} from './patch/apply';
import type {ApplyPatchOptions, ApplyPatchesOptions} from './patch/apply';
import {parsePatch} from './patch/parse';
import {reversePatch} from './patch/reverse';
import {
  structuredPatch,
  createTwoFilesPatch,
  createPatch,
  formatPatch,
  INCLUDE_HEADERS,
  FILE_HEADERS_ONLY,
  OMIT_HEADERS
} from './patch/create';
import type {
  StructuredPatchOptionsAbortable,
  StructuredPatchOptionsNonabortable,
  CreatePatchOptionsAbortable,
  CreatePatchOptionsNonabortable,
  HeaderOptions
} from './patch/create';

import {convertChangesToDMP} from './convert/dmp';
import {convertChangesToXML} from './convert/xml';
import type {
  ChangeObject,
  Change,
  ArrayChange,
  DiffArraysOptionsAbortable,
  DiffArraysOptionsNonabortable,
  DiffCharsOptionsAbortable,
  DiffCharsOptionsNonabortable,
  DiffLinesOptionsAbortable,
  DiffLinesOptionsNonabortable,
  DiffWordsOptionsAbortable,
  DiffWordsOptionsNonabortable,
  DiffSentencesOptionsAbortable,
  DiffSentencesOptionsNonabortable,
  DiffJsonOptionsAbortable,
  DiffJsonOptionsNonabortable,
  DiffCssOptionsAbortable,
  DiffCssOptionsNonabortable,
  StructuredPatch,
  StructuredPatchHunk
} from './types';

export {
  Diff,

  diffChars,
  characterDiff,
  diffWords,
  wordDiff,
  diffWordsWithSpace,
  wordsWithSpaceDiff,
  diffLines,
  lineDiff,
  diffTrimmedLines,
  diffSentences,
  sentenceDiff,
  diffCss,
  cssDiff,
  diffJson,
  jsonDiff,
  diffArrays,
  arrayDiff,

  structuredPatch,
  createTwoFilesPatch,
  createPatch,
  formatPatch,
  INCLUDE_HEADERS,
  FILE_HEADERS_ONLY,
  OMIT_HEADERS,
  applyPatch,
  applyPatches,
  parsePatch,
  reversePatch,
  convertChangesToDMP,
  convertChangesToXML,
  canonicalize
};

export type {
  ChangeObject,
  Change,
  ArrayChange,
  DiffArraysOptionsAbortable,
  DiffArraysOptionsNonabortable,
  DiffCharsOptionsAbortable,
  DiffCharsOptionsNonabortable,
  DiffLinesOptionsAbortable,
  DiffLinesOptionsNonabortable,
  DiffWordsOptionsAbortable,
  DiffWordsOptionsNonabortable,
  DiffSentencesOptionsAbortable,
  DiffSentencesOptionsNonabortable,
  DiffJsonOptionsAbortable,
  DiffJsonOptionsNonabortable,
  DiffCssOptionsAbortable,
  DiffCssOptionsNonabortable,
  StructuredPatch,
  StructuredPatchHunk,

  ApplyPatchOptions,
  ApplyPatchesOptions,

  StructuredPatchOptionsAbortable,
  StructuredPatchOptionsNonabortable,
  CreatePatchOptionsAbortable,
  CreatePatchOptionsNonabortable,
  HeaderOptions
};
