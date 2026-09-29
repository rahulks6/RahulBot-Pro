import { config } from "../../config/env";
import { LocalDiskMediaStorage, type MediaStorage } from "./storage";

export const mediaStorage: MediaStorage = new LocalDiskMediaStorage(config.media.storageRoot);
