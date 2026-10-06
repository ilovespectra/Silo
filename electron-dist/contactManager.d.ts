export interface ContactEntry {
    phoneNumber: string;
    savedName: string;
}
export interface ContactBook {
    contacts: Record<string, string>;
}
export declare class ContactManager {
    private readonly userDataPath;
    private readonly contactsPath;
    private contacts;
    constructor(userDataPath: string);
    private log;
    initialize(): Promise<void>;
    setContactName(phoneNumber: string, savedName: string | null): Promise<void>;
    getContactName(phoneNumber: string): string | undefined;
    getAllContacts(): ContactEntry[];
    private persistContacts;
}
