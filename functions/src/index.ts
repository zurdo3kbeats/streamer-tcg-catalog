import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

type Variant = "normal" | "vip";
type Reward = { coins: number; gems: number; items?: Array<{id:string; qty:number}> };

// Recompensas (ajústalas cuando quieras)
const DAILY_NORMAL: Reward = { coins: 100, gems: 5 };
const DAILY_VIP:    Reward = { coins: 250, gems: 15 };

const dayKeyUTC = (d: Date) => d.toISOString().slice(0,10); // YYYY-MM-DD UTC

export const claimDailyLogin = functions
  .region("europe-west1") // <-- cambia si usas otra región
  .https.onCall(async (data, ctx) => {
    if (!ctx.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");
    const uid = ctx.auth.uid;

    const variant = String(data?.variant || "normal") as Variant;
    if (variant !== "normal" && variant !== "vip") {
      throw new functions.https.HttpsError("invalid-argument", "variant must be 'normal' or 'vip'");
    }

    const now = admin.firestore.Timestamp.now();
    const todayKey = dayKeyUTC(now.toDate());

    const userRef = db.doc(`players/${uid}`); // coincide con tus reglas
    const missionRef = userRef.collection("missions").doc("daily_login");

    let rewardsGranted: Reward | null = null;

    await db.runTransaction(async (tx) => {
      const [userSnap, missionSnap] = await Promise.all([tx.get(userRef), tx.get(missionRef)]);

      // Doc base si no existe
      if (!userSnap.exists) {
        tx.set(userRef, {
          createdAt: now,
          economy: { coins: 0, gems: 0 },
          vip: { isActive: false, expiresAt: null }
        }, { merge: true });
      }

      const user = (userSnap.data() || {}) as any;
      const vipActive = !!user.vip?.isActive &&
        (!user.vip?.expiresAt || user.vip.expiresAt.toDate() >= now.toDate());

      if (variant === "vip" && !vipActive) {
        throw new functions.https.HttpsError("failed-precondition", "VIP required");
      }

      const mission = (missionSnap.exists ? missionSnap.data() : {}) as any;
      const instances = mission.instances || {};
      const today = instances[todayKey] || { completed:false, claimedNormal:false, claimedVip:false };

      // Idempotencia por variante
      if (variant === "normal" && today.claimedNormal)
        throw new functions.https.HttpsError("already-exists", "Normal reward already claimed today");
      if (variant === "vip" && today.claimedVip)
        throw new functions.https.HttpsError("already-exists", "VIP reward already claimed today");

      // Recompensa
      const reward = variant === "vip" ? DAILY_VIP : DAILY_NORMAL;
      rewardsGranted = reward;

      // Aplica economía
      tx.set(userRef, {
        "economy.coins": admin.firestore.FieldValue.increment(reward.coins || 0),
        "economy.gems":  admin.firestore.FieldValue.increment(reward.gems  || 0),
      }, { merge: true });

      // Marca misión
      if (variant === "normal") today.claimedNormal = true;
      if (variant === "vip")    today.claimedVip = true;
      today.completed = true;
      instances[todayKey] = today;

      tx.set(missionRef, { instances, updatedAt: now }, { merge: true });
    });

    return { ok: true, rewardsGranted };
  });
