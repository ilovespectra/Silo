import React, { useState, useEffect } from "react";
import { FiEdit2, FiSave, FiX, FiBook } from "react-icons/fi";
import "../styles/AddressBook.css";

interface Contact {
  phoneNumber: string;
  savedName: string;
}

export const AddressBook: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const electronAPI = window.electron;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [editingPhone, setEditingPhone] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadContacts = async () => {
      if (!electronAPI) return;
      setLoading(true);
      try {
        const loaded = await electronAPI.getAllContacts();
        setContacts(
          loaded.sort((a, b) => a.savedName.localeCompare(b.savedName)),
        );
      } catch (error) {
        console.error("Failed to load contacts:", error);
      } finally {
        setLoading(false);
      }
    };
    loadContacts();
  }, [electronAPI]);

  const startEdit = (phone: string, name: string) => {
    setEditingPhone(phone);
    setEditingName(name);
  };

  const saveEdit = async () => {
    if (!electronAPI || !editingPhone) return;
    try {
      const result = await electronAPI.setContactName(
        editingPhone,
        editingName,
      );
      if (result.ok) {
        setContacts((current) =>
          current.map((contact) =>
            contact.phoneNumber === editingPhone
              ? { ...contact, savedName: editingName }
              : contact,
          ),
        );
      }
    } catch (error) {
      console.error("Failed to save contact:", error);
    } finally {
      setEditingPhone(null);
      setEditingName("");
    }
  };

  const deleteContact = async (phone: string) => {
    if (!electronAPI) return;
    try {
      const result = await electronAPI.setContactName(phone, null);
      if (result.ok) {
        setContacts((current) =>
          current.filter((contact) => contact.phoneNumber !== phone),
        );
      }
    } catch (error) {
      console.error("Failed to delete contact:", error);
    }
  };

  const cancelEdit = () => {
    setEditingPhone(null);
    setEditingName("");
  };

  return (
    <div className="address-book-modal">
      <div className="address-book-container">
        <div className="address-book-header">
          <div className="address-book-title">
            <FiBook /> Address Book ({contacts.length})
          </div>
          <button
            onClick={onClose}
            className="close-button"
            title="Close address book"
          >
            <FiX />
          </button>
        </div>

        {loading ? (
          <div className="address-book-empty">Loading contacts...</div>
        ) : contacts.length === 0 ? (
          <div className="address-book-empty">
            No saved contacts yet. Rename numbers in the conversation list to
            create entries.
          </div>
        ) : (
          <div className="address-book-list">
            {contacts.map((contact) => (
              <div key={contact.phoneNumber} className="address-book-item">
                {editingPhone === contact.phoneNumber ? (
                  <>
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      autoFocus
                      className="address-book-input"
                    />
                    <small className="address-book-phone">
                      {contact.phoneNumber}
                    </small>
                    <button
                      onClick={saveEdit}
                      className="address-book-action save"
                      title="Save"
                    >
                      <FiSave />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="address-book-action cancel"
                      title="Cancel"
                    >
                      <FiX />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="address-book-entry">
                      <div className="address-book-name">
                        {contact.savedName}
                      </div>
                      <div className="address-book-phone">
                        {contact.phoneNumber}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        startEdit(contact.phoneNumber, contact.savedName)
                      }
                      className="address-book-action edit"
                      title="Edit"
                    >
                      <FiEdit2 />
                    </button>
                    <button
                      onClick={() => deleteContact(contact.phoneNumber)}
                      className="address-book-action delete"
                      title="Delete"
                    >
                      <FiX />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
