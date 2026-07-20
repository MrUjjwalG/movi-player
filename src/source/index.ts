export type { SourceAdapter, SourceFactory } from './SourceAdapter';
export { HttpSource, createHttpSource } from './HttpSource';
export { FileSource, createFileSource } from './FileSource';
export { ThumbnailHttpSource, createThumbnailHttpSource } from './ThumbnailHttpSource';
export { EncryptedHttpSource } from './EncryptedHttpSource';
export type { EncryptedSourceConfig } from './EncryptedHttpSource';
export { analyzeDashFallback } from './DashFallback';
export type { DashFallbackPlan } from './DashFallback';
export { generateFingerprint } from '../utils/Fingerprint';
export {
  registerSourceAdapter,
  unregisterSourceAdapter,
  getRegisteredSchemes,
  getSourceAdapterFactory,
  isOpenableScheme,
} from './adapterRegistry';
export type {
  SourceAdapterFactory,
  SourceAdapterFactoryConfig,
} from './adapterRegistry';
