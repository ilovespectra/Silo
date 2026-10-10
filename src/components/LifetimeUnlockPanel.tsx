import React, { FormEvent, useEffect, useRef, useState } from "react";
import {
  FiCheck,
  FiCopy,
  FiCreditCard,
  FiLock,
  FiMail,
  FiX,
} from "react-icons/fi";
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

type PaywallAction = "bug" | "survey" | "payment";

type BeetleCue = {
  left: number;
  top: number;
  phase: "rising" | "pointing" | "jiggling" | "returning" | "resting";
};

const SURVEY_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSdmJUIwdorndOfe6_45kXND8P2aSvgKid2iIoqQtz8WqVzdpQ/viewform?usp=publish-editor";

interface LifetimeUnlockPanelProps {
  license: LifetimeLicenseState;
  demoTestingModeActive?: boolean;
  onClose: () => void;
  onOpenBugReport: () => void;
  onVerified: (license: LifetimeLicenseState) => void;
}

export default function LifetimeUnlockPanel({
  license,
  demoTestingModeActive = false,
  onClose,
  onOpenBugReport,
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
  const [cardPurchase, setCardPurchase] = useState<{
    purchaseId: string;
    claimToken: string;
  } | null>(null);
  const [startingCardPurchase, setStartingCardPurchase] = useState(false);
  const [cardNotice, setCardNotice] = useState("");
  const [cardStatus, setCardStatus] = useState<
    "idle" | "pending" | "verified" | "error"
  >("idle");
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
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [betaEmailNotice, setBetaEmailNotice] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [activationNotice, setActivationNotice] = useState("");
  const [activationStatus, setActivationStatus] = useState<
    BetaActivationResult["status"] | "idle"
  >("idle");
  const [activatingBeta, setActivatingBeta] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [surveyPosition, setSurveyPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [beetleCue, setBeetleCue] = useState<BeetleCue | null>(null);
  const videoFrameRef = useRef<HTMLDivElement>(null);

  const videoCue: PaywallAction | null =
    videoTime >= 12.5 && videoTime < 19
      ? "bug"
      : videoTime >= 27 && videoTime < 35
        ? "survey"
        : videoTime >= 43 && videoTime < 54
          ? "payment"
          : null;

  useEffect(() => {
    if (videoCue !== "bug") {
      setBeetleCue(null);
      return;
    }

    const launcher = document.querySelector<HTMLElement>(".bug-report-launcher");
    const frame = videoFrameRef.current?.getBoundingClientRect();
    if (!frame) return;

    const launcherBounds = launcher?.getBoundingClientRect();
    const start = launcherBounds
      ? {
          left: launcherBounds.left + launcherBounds.width / 2,
          top: launcherBounds.top + launcherBounds.height / 2,
        }
      : { left: window.innerWidth - 40, top: window.innerHeight - 40 };
    const point = {
      left: frame.left + frame.width * 0.72,
      top: frame.top + frame.height * 0.74,
    };

    setBeetleCue({ ...start, phase: "rising" });
    const moveFrame = window.requestAnimationFrame(() => {
      setBeetleCue({ ...point, phase: "pointing" });
    });
    const jiggleTimer = window.setTimeout(
      () => setBeetleCue((current) => current && { ...current, phase: "jiggling" }),
      760,
    );
    const returnTimer = window.setTimeout(
      () => setBeetleCue({ ...start, phase: "returning" }),
      1320,
    );
    const flashTimer = window.setTimeout(
      () => setBeetleCue((current) => current && { ...current, phase: "resting" }),
      1940,
    );
    const finishTimer = window.setTimeout(() => setBeetleCue(null), 3450);

    return () => {
      window.cancelAnimationFrame(moveFrame);
      window.clearTimeout(jiggleTimer);
      window.clearTimeout(returnTimer);
      window.clearTimeout(flashTimer);
      window.clearTimeout(finishTimer);
    };
  }, [videoCue]);

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
    if (license.isLicensed || !cardPurchase || !window.electron) return;

    const electron = window.electron;
    let disposed = false;
    let checking = false;
    const checkCardPurchase = async () => {
      if (disposed || checking) return;
      checking = true;
      try {
        const result = await electron.checkLifetimeCardPurchase(
          cardPurchase.purchaseId,
          cardPurchase.claimToken,
        );
        if (disposed) return;
        setCardNotice(result.message || "Waiting for payment verification…");
        if (result.status === "verified" && result.signature) {
          const localVerification = await electron.verifyLifetimeCardPayment(
            result.signature,
          );
          if (disposed) return;
          setCardStatus(localVerification.status === "verified" ? "verified" : "error");
          setCardNotice(localVerification.message);
          if (localVerification.license?.isLicensed)
            onVerified(localVerification.license);
        } else if (result.status === "error") {
          setCardStatus("error");
        } else if (result.status === "expired") {
          setCardStatus("error");
        } else {
          setCardStatus("pending");
        }
      } catch {
        if (!disposed) {
          setCardStatus("error");
          setCardNotice("The license relay is temporarily unavailable. Silo will keep checking.");
        }
      } finally {
        checking = false;
      }
    };

    void checkCardPurchase();
    const timer = window.setInterval(() => void checkCardPurchase(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [cardPurchase, license.isLicensed, onVerified]);

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

  const startCardPurchase = async () => {
    if (!window.electron || startingCardPurchase) return;
    setStartingCardPurchase(true);
    setCardStatus("pending");
    setCardNotice("Starting secure card checkout in your default browser…");
    try {
      const result = await window.electron.beginLifetimeCardPurchase();
      if (!result.ok) {
        setCardStatus("error");
        setCardNotice(result.error);
        return;
      }
      setCardPurchase({
        purchaseId: result.purchaseId,
        claimToken: result.claimToken,
      });
      setCardStatus("pending");
      setCardNotice(
        "Complete checkout in your browser. Keep Silo open; it will verify the payment and activate your license.",
      );
    } catch {
      setCardStatus("error");
      setCardNotice("Card checkout could not be started. No license status was changed.");
    } finally {
      setStartingCardPurchase(false);
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

  const sendBetaActivationRequest = async () => {
    if (!window.electron?.submitBetaActivationRequest) {
      setBetaEmailState("error");
      setBetaEmailNotice("Beta requests are unavailable in this session.");
      return;
    }
    setBetaEmailState("sending");
    setBetaEmailNotice("");
    try {
      const result = await window.electron.submitBetaActivationRequest();
      if (!result.ok) {
        setBetaEmailState("error");
        setBetaEmailNotice(result.error || "Silo could not send the beta request.");
        return;
      }
      setBetaEmailState("sent");
      setBetaEmailNotice(
        `Beta request sent to ${betaActivationInfo?.requestEmail ?? "the beta team"}.`,
      );
    } catch {
      setBetaEmailState("error");
      setBetaEmailNotice("Silo could not send the beta request. Try again when online.");
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

  const activatePaywallAction = (action: PaywallAction) => {
    if (action === "bug") {
      onOpenBugReport();
      return;
    }
    if (action === "survey") {
      const frame = videoFrameRef.current?.getBoundingClientRect();
      if (frame) {
        const width = Math.min(560, window.innerWidth - 24);
        const height = Math.min(640, window.innerHeight - 24);
        const pointX = frame.left + frame.width * 0.72;
        const pointY = frame.top + frame.height * 0.72;
        setSurveyPosition({
          left: Math.max(12, Math.min(pointX - width / 2, window.innerWidth - width - 12)),
          top: Math.max(12, Math.min(pointY - height / 2, window.innerHeight - height - 12)),
        });
      } else {
        setSurveyPosition(null);
      }
      setSurveyOpen(true);
      return;
    }
    setPaymentOpen(true);
  };

  return (
    <div
      className="lifetime-unlock-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lifetime-unlock-composition">
        {!license.isLicensed && (
          <section
            className="lifetime-unlock-video-section"
            aria-label="A thank-you message for trying Silo"
          >
            <div
              className="lifetime-video-actions"
              role="group"
              aria-label="Paywall links"
            >
              <button type="button" onClick={() => activatePaywallAction("bug")}>
                Report a Bug
              </button>
              <button
                type="button"
                onClick={() =>
                  document
                    .getElementById("lifetime-beta-access")
                    ?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                }
              >
                Request Beta Access
              </button>
              <button type="button" onClick={() => activatePaywallAction("survey")}>
                Complete Survey
              </button>
              <button type="button" onClick={() => activatePaywallAction("payment")}>
                Pay with Solana
              </button>
            </div>
            <div className="lifetime-unlock-video-frame" ref={videoFrameRef}>
              <video
                className="lifetime-unlock-video"
                autoPlay
                controls
                preload="metadata"
                playsInline
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  video.preservesPitch = true;
                  video.defaultPlaybackRate = 1.1;
                  video.playbackRate = 1.1;
                }}
                poster={`${process.env.PUBLIC_URL}/lifetime-thank-you-paywall-refined-poster.jpg`}
                aria-label="A thank-you video from Tanny"
                onTimeUpdate={(event) =>
                  setVideoTime(event.currentTarget.currentTime)
                }
              >
                <source
                  src={`${process.env.PUBLIC_URL}/lifetime-thank-you-paywall-refined.mp4`}
                  type="video/mp4"
                />
                Your browser does not support this video.
              </video>
              {videoCue && (
                <button
                  className="lifetime-video-cue"
                  type="button"
                  onClick={() => activatePaywallAction(videoCue)}
                >
                  {videoCue === "bug"
                    ? "Report a Bug"
                    : videoCue === "survey"
                      ? "Complete Survey"
                      : "See Solana Payment"}
                </button>
              )}
            </div>
            {beetleCue && (
              <div
                className={`lifetime-video-beetle ${beetleCue.phase}`}
                style={{ left: beetleCue.left, top: beetleCue.top }}
                aria-hidden="true"
              >
                <svg viewBox="0 0 48 48" focusable="false">
                  <path d="m18 13-5-6m17 6 5-6M13 23l-7-3m29 3 7-3M13 31l-7 3m29-3 7 3" />
                  <path className="beetle-shell" d="M24 13c-8 0-13 6-13 15 0 8 5 14 13 14s13-6 13-14c0-9-5-15-13-15Z" />
                  <path className="beetle-seam" d="M24 15v25" />
                  <circle className="beetle-spot" cx="18" cy="23" r="2.1" />
                  <circle className="beetle-spot" cx="30" cy="23" r="2.1" />
                  <circle className="beetle-spot" cx="18" cy="32" r="2.1" />
                  <circle className="beetle-spot" cx="30" cy="32" r="2.1" />
                  <path className="beetle-head" d="M18 13c0-4 2.4-7 6-7s6 3 6 7" />
                  <circle className="beetle-eye" cx="21.5" cy="10" r="1" />
                  <circle className="beetle-eye" cx="26.5" cy="10" r="1" />
                </svg>
              </div>
            )}
          </section>
        )}

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
            <section className="lifetime-solana-pay" aria-label="Pay with Solana Pay">
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

            <section
              id="lifetime-beta-access"
              className="lifetime-beta-panel"
              aria-label="Beta tester access"
            >
              <div className="lifetime-beta-heading">
                <strong>Request full lifetime access for beta testing</strong>
                <p>
                  If approved, please push Silo to its limits and try to break
                  it. Share bugs and rough edges so we can improve it. We’ll
                  send a follow-up survey one week after activation. This
                  installation’s request code will be emailed to{" "}
                  {betaActivationInfo?.requestEmail ?? "the beta team"}.
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
                    onClick={() => void sendBetaActivationRequest()}
                    disabled={betaEmailState === "sending"}
                  >
                    <FiMail />
                    {betaEmailState === "sending"
                      ? "Sending request…"
                      : betaEmailState === "sent"
                        ? "Request sent"
                        : "Send beta access request"}
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
      {surveyOpen && (
        <div
          className="lifetime-action-backdrop lifetime-survey-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSurveyOpen(false);
          }}
        >
          <section
            className="lifetime-survey-dialog"
            style={surveyPosition ?? undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="lifetime-survey-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSurveyOpen(false);
              }
            }}
          >
            <header className="lifetime-survey-header">
              <h2 id="lifetime-survey-title">Silo Demo Feedback</h2>
              <button
                className="lifetime-unlock-close"
                type="button"
                aria-label="Close feedback survey"
                onClick={() => setSurveyOpen(false)}
              >
                <FiX />
              </button>
            </header>
            <iframe
              className="lifetime-survey-frame"
              title="Silo Demo Feedback survey"
              src={SURVEY_FORM_URL}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </section>
        </div>
      )}
      {paymentOpen && (
        <div
          className="lifetime-action-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPaymentOpen(false);
          }}
        >
          <section
            className="lifetime-payment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lifetime-payment-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setPaymentOpen(false);
              }
            }}
          >
            <header className="lifetime-survey-header">
              <div>
                <span className="lifetime-unlock-eyebrow">LIFETIME ACCESS</span>
                <h2 id="lifetime-payment-title">Choose how to pay</h2>
              </div>
              <button
                className="lifetime-unlock-close"
                type="button"
                aria-label="Close payment details"
                onClick={() => setPaymentOpen(false)}
              >
                <FiX />
              </button>
            </header>
            <p className="lifetime-action-payment-intro">
              Send $25 USDC with the Solana Pay request, or use an installed
              wallet or card in your browser. Silo verifies the finalized
              payment before activation.
            </p>
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
            <div className="lifetime-payment-divider">
              <span>OR CHECK OUT IN YOUR BROWSER</span>
            </div>
            <section className="lifetime-card-checkout" aria-label="Wallet or card checkout">
              <span className="lifetime-card-checkout-label">
                INSTALLED WALLET OR CARD · HELIO
              </span>
              <button
                className="lifetime-card-checkout-button"
                type="button"
                disabled={startingCardPurchase || license.isLicensed}
                onClick={() => void startCardPurchase()}
              >
                <FiCreditCard aria-hidden="true" />
                {startingCardPurchase
                  ? "Opening secure checkout…"
                  : "Open wallet or card checkout · $25"}
              </button>
              <p>
                Connect an installed wallet or choose card checkout in your
                browser. Card details stay with the payment provider.
              </p>
              {cardNotice && (
                <p
                  className="lifetime-card-checkout-note"
                  data-status={cardStatus}
                  role="status"
                >
                  {cardNotice}
                </p>
              )}
            </section>
            <p className="lifetime-payment-safety-note">
              Never enter a seed phrase or private key in Silo.
            </p>
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
        </div>
      )}
      </div>
    </div>
  );
}
