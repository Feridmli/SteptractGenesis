import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// =======================================
// 1. SUPABASE KONFİQURASİYASI
// =======================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =======================================
// 2. SABİTLƏR
// =======================================
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS;

// Kolleksiyanın ümumi adı
const COLLECTION_NAME_PREFIX = "Steptract Genesis"; 

// 🛑 STOP LIMITİ: Yalnız ilk 2200 NFT oxunacaq (1/1-lər görünməyəcək)
const MAX_NFT_ID = 2200; 

const RPC_LIST = [
  process.env.APECHAIN_RPC,
  "https://rpc.apechain.com",
  "https://apechain.drpc.org",
  "https://33139.rpc.thirdweb.com"
];

let providerIndex = 0;
function getProvider() {
  const rpc = RPC_LIST[providerIndex % RPC_LIST.length];
  providerIndex++;
  return new ethers.providers.JsonRpcProvider(rpc);
}

let provider = getProvider();

// =======================================
// 3. NFT CONTRACT
// =======================================
const nftABI = [
  "function ownerOf(uint256 tokenid) view returns (address)",
  "function totalSupply() view returns (uint256)"
];

let nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, nftABI, provider);

// =======================================
// 4. ƏSAS PROSES (PROCESS NFT)
// =======================================
async function processNFT(tokenid) {
  try {
    let owner, success = false;

    // A. Blokçeyndən yalnız SAHİBİ (Owner) oxuyuruq
    for (let i = 0; i < RPC_LIST.length; i++) {
      try {
        owner = await nftContract.ownerOf(tokenid);
        success = true;
        break;
      } catch (err) {
        if (err.message && err.message.includes("nonexistent token")) return;
        provider = getProvider();
        nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, nftABI, provider);
      }
    }

    if (!success) {
      console.error(`❌ NFT #${tokenid} sahibi tapılmadı.`);
      return;
    }

    // B. Adı sadəcə ID-yə görə formalaşdırırıq
    const generatedName = `${COLLECTION_NAME_PREFIX} #${tokenid}`;
    
    const now = new Date().toISOString();
    const ownerLower = owner.toLowerCase();

    // C. DB yoxlanışı
    const { data: existingData } = await supabase
      .from("metadata")
      .select("seller_address, price, seaport_order, order_hash")
      .eq("tokenid", tokenid.toString())
      .single();

    let shouldWipeListing = false;

    if (existingData && existingData.seller_address) {
        if (existingData.seller_address.toLowerCase() !== ownerLower) {
            // console.log(`♻️ NFT #${tokenid} sahibi dəyişib. Listing silinir.`);
            shouldWipeListing = true;
        }
    }

    // D. Upsert üçün məlumat
    const upsertData = {
      tokenid: tokenid.toString(),
      nft_contract: NFT_CONTRACT_ADDRESS,
      buyer_address: ownerLower,
      name: generatedName, 
      image: null, // Şəkil göstərməyəcəyik
      updatedat: now
    };

    if (shouldWipeListing) {
      upsertData.price = null;
      upsertData.seller_address = null;
      upsertData.seaport_order = null;
      upsertData.order_hash = null;
      upsertData.status = "inactive"; 
    } else if (existingData) {
      upsertData.price = existingData.price;
      upsertData.seller_address = existingData.seller_address;
      upsertData.seaport_order = existingData.seaport_order;
      upsertData.order_hash = existingData.order_hash;
    }

    const { error } = await supabase
      .from("metadata")
      .upsert(upsertData, { onConflict: "tokenid" });

    if (error) {
      console.error(`DB Error #${tokenid}:`, error.message);
    } else {
      // Hər dəfə log çıxmasın deyə, hər 50 dənədən bir yazdırır
      if (tokenid % 50 === 0) console.log(`✅ Synced up to #${tokenid}`);
    }

  } catch (e) {
    console.warn(`❌ Gözlənilməz xəta #${tokenid}:`, e.message);
  }
}

// =======================================
// 5. MAIN LOOP (LIMITLİ)
// =======================================
async function main() {
  console.log(`🚀 Sürətli Sync prosesi başladılır... Limit: ${MAX_NFT_ID}`);
  
  try {
    // TotalSupply sadəcə məlumat üçün loglanır, dövr üçün istifadə olunmur
    try {
        const totalSupply = await nftContract.totalSupply();
        console.log(`📦 Blokçeyndəki ümumi NFT: ${totalSupply.toString()} (Biz yalnız ${MAX_NFT_ID}-ə qədər oxuyacağıq)`);
    } catch (e) { console.log("Total supply oxuna bilmədi, davam edirik..."); }

    const BATCH_SIZE = 50; 
    
    // LOOP: totalSupply YOX, MAX_NFT_ID istifadə edirik
    for (let i = 1; i <= MAX_NFT_ID; i += BATCH_SIZE) {
      const batchIds = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        const currentId = i + j;
        // Limiti keçməməsini təmin edirik
        if (currentId <= MAX_NFT_ID) {
            batchIds.push(currentId);
        }
      }

      if (batchIds.length > 0) {
          await Promise.all(batchIds.map(id => processNFT(id)));
          console.log(`Batch ${batchIds[0]}-${batchIds[batchIds.length-1]} bitdi.`);
      }
    }

    console.log("🎉 Proses bitdi! 2201-dən yuxarı NFT-lər daxil edilmədi.");
    process.exit(0);
    
  } catch (err) {
    console.error("💀 Error:", err);
    process.exit(1);
  }
}

main();
