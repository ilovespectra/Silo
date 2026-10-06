import React, { FormEvent, useEffect, useState } from "react";
import { FiCheck, FiCopy, FiLock, FiMail, FiX } from "react-icons/fi";
import { QRCodeSVG } from "qrcode.react";
import type {
  LifetimeLicenseState,
  LifetimePaymentStatus,
} from "../lifetimePayment";
import {
  createLifetimeSolanaPayUri,
  encodeSolanaPayReference,
  LIFETIME_PAYMENT_ADDRESS,
} from "../lifetimePayment";
import type {
  BetaActivationInfo,
  BetaActivationResult,
} from "../betaLicense";
import "./LifetimeUnlockPanel.css";

interface LifetimeUnlockPanelProps {
  license: LifetimeLicenseState;
  demoTestingModeActive?: boolean;
  onClose: () => void;
  onVerified: (license: LifetimeLicenseState) => void;
}

export default function LifetimeUnlockPanel({
  license,
  demoTestingModeActive = false,
  onClose,
  onVerified,
}: LifetimeUnlockPanelProps) {
  const [paymentRequest] = useState(() => {
    if (!window.crypto?.getRandomValues) return null;
    const randomBytes = window.crypto.getRandomValues(new Uint8Array(32));
    const reference = encodeSolanaPayReference(randomBytes);
    return { reference, uri: createLifetimeSolanaPayUri(reference) };
  });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [paymentLinkCopyState, setPaymentLinkCopyState] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const [paymentNotice, setPaymentNotice] = useState("");
  const [paymentStatus, setPaymentStatus] =
    useState<LifetimePaymentStatus | "idle">("idle");
  const [signature, setSignature] = useState("");
  const [verificationNotice, setVerificationNotice] = useState("");
  const [verificationStatus, setVerificationStatus] =
    useState<LifetimePaymentStatus | "idle">("idle");
  const [verifying, setVerifying] = useState(false);
  const [betaActivationInfo, setBetaActivationInfo] =
    useState<BetaActivationInfo | null>(null);
  const [betaCopyState, setBetaCopyState] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const [betaEmailState, setBetaEmailState] = useState<
    "idle" | "opening" | "opened" | "error"
  >("idle");
  const [betaEmailNotice, setBetaEmailNotice] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [activationNotice, setActivationNotice] = useState("");
  const [activationStatus, setActivationStatus] = useState<
    BetaActivationResult["status"] | "idle"
  >("idle");
  const [activatingBeta, setActivatingBeta] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.electron
      ?.getBetaActivationInfo()
      .then((info) => {
        if (!disposed) setBetaActivationInfo(info);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (license.isLicensed || !paymentRequest || !window.electron) return;

    const electron = window.electron;
    let disposed = false;
    let checking = false;
    const checkPayment = async () => {
      if (disposed || checking) return;
      checking = true;
      try {
        const result = await electron.checkLifetimePaymentReference(
          paymentRequest.reference,
        );
        if (disposed) return;
        setPaymentStatus(result.status);
        setPaymentNotice(result.message);
        if (result.license?.isLicensed) onVerified(result.license);
      } catch {
        if (disposed) return;
        setPaymentStatus("error");
        setPaymentNotice(
          "Could not check Solana right now. Silo will keep checking.",
        );
      } finally {
        checking = false;
      }
    };

    void checkPayment();
    const timer = window.setInterval(() => void checkPayment(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [license.isLicensed, onVerified, paymentRequest]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(LIFETIME_PAYMENT_ADDRESS);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const copyPaymentLink = async () => {
    if (!paymentRequest) return;
    try {
      await navigator.clipboard.writeText(paymentRequest.uri);
      setPaymentLinkCopyState("copied");
    } catch {
      setPaymentLinkCopyState("error");
    }
  };

  const verifyPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!window.electron) {
      setVerificationStatus("error");
      setVerificationNotice("Payment verification is unavailable in this session.");
      return;
    }
    setVerifying(true);
    setVerificationNotice("");
    try {
      const result = await window.electron.verifyLifetimePayment(
        signature.trim(),
      );
      setVerificationStatus(result.status);
      setVerificationNotice(result.message);
      if (result.license?.isLicensed) onVerified(result.license);
    } catch {
      setVerificationStatus("error");
      setVerificationNotice(
        "Could not verify with Solana right now. No license status was changed.",
      );
    } finally {
      setVerifying(false);
    }
  };

  const copyBetaRequestCode = async () => {
    if (!betaActivationInfo?.requestCode) return;
    try {
      await navigator.clipboard.writeText(betaActivationInfo.requestCode);
      setBetaCopyState("copied");
    } catch {
      setBetaCopyState("error");
    }
  };

  const openBetaActivationRequestEmail = async () => {
    if (!window.electron?.openBetaActivationRequestEmail) {
      setBetaEmailState("error");
      setBetaEmailNotice("Email requests are unavailable in this session.");
      return;
    }
    setBetaEmailState("opening");
    setBetaEmailNotice("");
    try {
      await window.electron.openBetaActivationRequestEmail();
      setBetaEmailState("opened");
      setBetaEmailNotice(
        "Your email app opened with a draft. Review it and press Send when ready.",
      );
    } catch {
      setBetaEmailState("error");
      setBetaEmailNotice(
        `Could not open an email app. Copy the request code and email it to ${betaActivationInfo?.requestEmail ?? "the beta team"}.`,
      );
    }
  };

  const activateBeta = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!window.electron) {
      setActivationStatus("error");
      setActivationNotice("Beta activation is unavailable in this session.");
      return;
    }
    setActivatingBeta(true);
    setActivationNotice("");
    try {
      const result = await window.electron.activateBetaLicense(
        activationCode.trim(),
      );
      setActivationStatus(result.status);
      setActivationNotice(result.message);
      if (result.license?.isLicensed) onVerified(result.license);
    } catch {
      setActivationStatus("error");
      setActivationNotice("Silo could not check or save that beta code.");
    } finally {
      setActivatingBeta(false);
    }
  };

  return (
    <div
      className="lifetime-unlock-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="lifetime-unlock-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifetime-unlock-title"
      >
        <header className="lifetime-unlock-header">
          <div className="lifetime-unlock-mark" aria-hidden="true">
            <FiLock />
          </div>
          <div>
            <span className="lifetime-unlock-eyebrow">LIFETIME ACCESS</span>
            <h2 id="lifetime-unlock-title">Make Silo yours</h2>
          </div>
          <button
            className="lifetime-unlock-close"
            type="button"
            aria-label="Close lifetime unlock"
            onClick={onClose}
          >
            <FiX />
          </button>
        </header>

        <div className="lifetime-unlock-price">
          <strong>$25</strong>
          <span>USDC <i /> Solana</span>
          <p>Pay once. Keep Silo for life, with future updates included.</p>
        </div>

        <div className="lifetime-unlock-benefits">
          <div>
            <FiCheck />
            <span>Unlimited sources and files</span>
          </div>
          <div>
            <FiCheck />
            <span>Unlimited digital folders and memory previews</span>
          </div>
          <div>
            <FiCheck />
            <span>Unlimited mapped locations</span>
          </div>
        </div>

        {license.isLicensed ? (
          <div className="lifetime-unlock-saved" role="status">
            <FiCheck aria-hidden="true" />
            <div>
              <strong>
                {license.licenseType === "beta"
                  ? "Lifetime beta access active"
                  : "Lifetime license saved on this Mac"}
              </strong>
              <p>
                {demoTestingModeActive
                  ? "Your lifetime license remains saved; demo limits stay active until you turn off testing mode."
                  : license.licenseType === "beta"
                    ? "Full Silo access is active now; no restart is needed."
                    : "Silo is unlocked now; no restart is needed. Keep your transaction signature to restore this license if you ever need to."}
              </p>
            </div>
          </div>
        ) : (
          <>
            <section
              className="lifetime-solana-pay"
              aria-label="Pay with Solana Pay"
            >
              <div className="lifetime-unlock-step">
                <span>01</span>
                <div>
                  <strong>Scan to pay with your Solana wallet</strong>
                  <p>
                    Approve the $25 USDC one-time payment in your wallet. Silo
                    will confirm it on-chain and unlock automatically.
                  </p>
                </div>
              </div>
              <div className="lifetime-solana-qr">
                {paymentRequest ? (
                  <QRCodeSVG
                    value={paymentRequest.uri}
                    size={190}
                    level="M"
                    marginSize={3}
                    role="img"
                    aria-label="Solana Pay request for 25 USDC"
                  />
                ) : (
                  <p role="alert">Silo could not create a secure payment request.</p>
                )}
              </div>
              <p className="lifetime-solana-instructions">
                Scan with a Solana wallet on your phone. If your USDC is on
                another network, bridge it to Solana first; Silo never moves or
                bridges funds.
              </p>
              {paymentRequest && (
                <button
                  className="lifetime-solana-copy-link"
                  type="button"
                  onClick={() => void copyPaymentLink()}
                >
                  {paymentLinkCopyState === "copied" ? <FiCheck /> : <FiCopy />}
                  {paymentLinkCopyState === "copied"
                    ? "Payment link copied"
                    : paymentLinkCopyState === "error"
                      ? "Copy failed"
                      : "Copy Solana Pay link"}
                </button>
              )}
              {paymentNotice && (
                <p
                  className="lifetime-unlock-inline-note"
                  data-status={paymentStatus}
                  role="status"
                >
                  {paymentNotice}
                </p>
              )}
            </section>

            <details className="lifetime-unlock-manual">
              <summary>Paid another way? Verify the transaction manually</summary>
              <div>
                <div className="lifetime-unlock-payment">
                  <div className="lifetime-unlock-step">
                    <span>02</span>
                    <div>
                      <strong>Send at least $25 USDC on Solana</strong>
                      <p>
                        Send USDC to this address, then paste the transaction
                        signature below. Silo checks for final confirmation.
                      </p>
                    </div>
                  </div>
                  <div className="lifetime-unlock-address">
                    <code>{LIFETIME_PAYMENT_ADDRESS}</code>
                    <button type="button" onClick={() => void copyAddress()}>
                      {copyState === "copied" ? <FiCheck /> : <FiCopy />}
                      {copyState === "copied"
                        ? "Copied"
                        : copyState === "error"
                          ? "Copy failed"
                          : "Copy address"}
                    </button>
                  </div>
                  {copyState === "error" && (
                    <p className="lifetime-unlock-inline-note" role="status">
                      Clipboard access failed. Select and copy the address above.
                    </p>
                  )}
                </div>

                <form
                  className="lifetime-unlock-verify"
                  onSubmit={verifyPayment}
                >
                  <label htmlFor="lifetime-unlock-signature">
                    <span>03</span>
                    <strong>Verify your transaction</strong>
                  </label>
                  <p>
                    Paste the transaction signature from your wallet.
                  </p>
                  <input
                    id="lifetime-unlock-signature"
                    autoComplete="off"
                    spellCheck={false}
                    value={signature}
                    onChange={(event) => {
                      setSignature(event.target.value);
                      setVerificationNotice("");
                      setVerificationStatus("idle");
                    }}
                    placeholder="Solana transaction signature"
                    disabled={verifying}
                  />
                  <button
                    type="submit"
                    disabled={!signature.trim() || verifying}
                  >
                    {verifying ? "Checking Solana…" : "Verify on-chain"}
                  </button>
                  {verificationNotice && (
                    <p
                      className="lifetime-unlock-inline-note"
                      data-status={verificationStatus}
                      role="status"
                    >
                      {verificationNotice}
                    </p>
                  )}
                </form>
              </div>
            </details>

            <section className="lifetime-beta-panel" aria-label="Beta tester access">
              <div className="lifetime-beta-heading">
                <strong>Beta tester access</strong>
                  <p>
                    Copy this installation-specific request code or open a
                  prefilled email to {betaActivationInfo?.requestEmail ?? "the beta team"}
                  to request a full lifetime beta license.
                  </p>
              </div>
              {betaActivationInfo ? (
                <>
                  <div className="lifetime-beta-request-code">
                    <code>{betaActivationInfo.requestCode}</code>
                    <button
                      type="button"
                      onClick={() => void copyBetaRequestCode()}
                    >
                      {betaCopyState === "copied" ? <FiCheck /> : <FiCopy />}
                      {betaCopyState === "copied"
                        ? "Copied"
                        : betaCopyState === "error"
                          ? "Copy failed"
                          : "Copy code"}
                    </button>
                  </div>
                  {betaCopyState === "error" && (
                    <p className="lifetime-unlock-inline-note" role="status">
                      Clipboard access failed. Select and copy the code above.
                    </p>
                  )}
                  <button
                    className="lifetime-beta-email-request"
                    type="button"
                    onClick={() => void openBetaActivationRequestEmail()}
                    disabled={betaEmailState === "opening"}
                  >
                    <FiMail />
                    {betaEmailState === "opening"
                      ? "Opening email…"
                      : betaEmailState === "opened"
                        ? "Open email again"
                        : "Email beta request"}
                  </button>
                  {betaEmailNotice && (
                    <p className="lifetime-unlock-inline-note" role="status">
                      {betaEmailNotice}
                    </p>
                  )}
                  {betaActivationInfo.available ? (
                    <form
                      className="lifetime-beta-activate"
                      onSubmit={activateBeta}
                    >
                      <label htmlFor="lifetime-beta-activation-code">
                        <strong>Enter your activation code</strong>
                      </label>
                      <input
                        id="lifetime-beta-activation-code"
                        autoComplete="off"
                        spellCheck={false}
                        value={activationCode}
                        onChange={(event) => {
                          setActivationCode(event.target.value);
                          setActivationNotice("");
                          setActivationStatus("idle");
                        }}
                        placeholder="Silo beta activation code"
                        disabled={activatingBeta}
                      />
                      <button
                        type="submit"
                        disabled={!activationCode.trim() || activatingBeta}
                      >
                        {activatingBeta ? "Activating…" : "Activate lifetime access"}
                      </button>
                      {activationNotice && (
                        <p
                          className="lifetime-unlock-inline-note"
                          data-status={activationStatus}
                          role="status"
                        >
                          {activationNotice}
                        </p>
                      )}
                    </form>
                  ) : (
                  <p className="lifetime-beta-unavailable" role="status">
                      Beta activation is not configured in this build. You can
                      still request a grant by email, but this build cannot
                      activate a response yet.
                  </p>
                  )}
                </>
              ) : (
                <p className="lifetime-beta-unavailable" role="status">
                  Preparing this installation's request code…
                </p>
              )}
            </section>
          </>
        )}

        <footer className="lifetime-unlock-footer">
          <span>Demo access stays available while you decide.</span>
          <span>Never enter a seed phrase or private key in Silo.</span>
        </footer>
      </section>
    </div>
  );
}
