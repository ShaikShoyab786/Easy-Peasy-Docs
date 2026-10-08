import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";

export const objectStorageService = new ObjectStorageService();

export async function removeStoredObject(objectPath: string): Promise<void> {
  try {
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    await file.delete({ ignoreNotFound: true });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      return;
    }
    throw error;
  }
}
