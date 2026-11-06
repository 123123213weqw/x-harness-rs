import {DecodedImageBudget} from '@xharness/dsh-client-ui-primitives'
export {DecodedImageBudget, ThumbnailQueue} from '@xharness/dsh-client-ui-primitives'
export {decodedImageBudget as historyImageBudget, imageReadQueue as thumbnailQueue} from '@xharness/dsh-client-ui-primitives'
// A sub-limit, not an extra budget: leave room for an explicit original.
export const historyThumbnailBudget = new DecodedImageBudget(48 * 1024 * 1024)
