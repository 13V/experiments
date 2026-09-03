// Stonk Packs site configuration. Edit this file; nothing else is chain-specific.
window.STONK_CONFIG = {
  chainId: 4663,
  chainIdHex: '0x1237',
  chainName: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  github: 'https://github.com/13V/experiments',

  // The StonkPacks contract. Leave empty until deployed: the site then runs in demo mode,
  // where packs open locally with the same randomness and odds code as the contract.
  contract: '',
  // L2 block the contract was deployed at; log searches never go further back than this.
  deployBlock: 0,
  // keccak256(seed_1), published with the deployment. Shown on the fairness panel.
  chainRoot: '',

  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  usdgDecimals: 6,
  packPriceUsd: 20,
  pulls: 5,

  // How the contract's clock maps to wall time: block.number is the Ethereum block number.
  secondsPerBlock: 12,
  openWindowBlocks: 200,

  // Display fallback for the odds table until the contract answers (and the whole table in demo mode).
  tiers: [
    {
      "name": "Common",
      "weight": 7200,
      "usd": 1,
      "tokens": [
        {
          "symbol": "F",
          "address": "0x25c288e6d899b9bc30160965ad9644c67e73be0c",
          "name": "Ford Motor"
        },
        {
          "symbol": "AMC",
          "address": "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b",
          "name": "AMC Entertainment"
        },
        {
          "symbol": "BB",
          "address": "0x48e39e56acdba37b09020c0b734a613c9a2f100a",
          "name": "Blackberry"
        },
        {
          "symbol": "SOFI",
          "address": "0x98e75885157c80992a8d41b696d8c9c6fb30a926",
          "name": "SoFi Technologies"
        },
        {
          "symbol": "RIVN",
          "address": "0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b",
          "name": "Rivian Automotive"
        },
        {
          "symbol": "SNAP",
          "address": "0xf6589f11bc40b669e584073f428b05562f568733",
          "name": "Snap"
        },
        {
          "symbol": "CCL",
          "address": "0x9651342cea770ae9a2969ba2a52611523146aef9",
          "name": "Carnival Corporation"
        },
        {
          "symbol": "HIMS",
          "address": "0xccee82fe024c36fa15e1005ede3e9e4787e23d09",
          "name": "Hims & Hers Health"
        },
        {
          "symbol": "SOUN",
          "address": "0x6e3dfd9f7e1649baa14d25cac18c94d62db10a54",
          "name": "SoundHound AI"
        },
        {
          "symbol": "RCAT",
          "address": "0xfde6b5d9bb419b10c23268c74e369abff39c0460",
          "name": "Red Cat"
        }
      ]
    },
    {
      "name": "Uncommon",
      "weight": 2000,
      "usd": 3,
      "tokens": [
        {
          "symbol": "AAPL",
          "address": "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
          "name": "Apple"
        },
        {
          "symbol": "MSFT",
          "address": "0xe93237c50d904957cf27e7b1133b510c669c2e74",
          "name": "Microsoft"
        },
        {
          "symbol": "GOOGL",
          "address": "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
          "name": "Alphabet Class A"
        },
        {
          "symbol": "AMZN",
          "address": "0x12f190a9f9d7d37a250758b26824b97ce941bf54",
          "name": "Amazon"
        },
        {
          "symbol": "META",
          "address": "0xc0d6457c16cc70d6790dd43521c899c87ce02f35",
          "name": "Meta Platforms"
        },
        {
          "symbol": "COIN",
          "address": "0x6330d8c3178a418788df01a47479c0ce7ccf450b",
          "name": "Coinbase"
        },
        {
          "symbol": "INTC",
          "address": "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681",
          "name": "Intel"
        },
        {
          "symbol": "AMD",
          "address": "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc",
          "name": "AMD"
        },
        {
          "symbol": "NFLX",
          "address": "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8",
          "name": "Netflix"
        },
        {
          "symbol": "RBLX",
          "address": "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8",
          "name": "Roblox"
        }
      ]
    },
    {
      "name": "Rare",
      "weight": 600,
      "usd": 12,
      "tokens": [
        {
          "symbol": "NVDA",
          "address": "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
          "name": "NVIDIA"
        },
        {
          "symbol": "TSLA",
          "address": "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
          "name": "Tesla"
        },
        {
          "symbol": "PLTR",
          "address": "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
          "name": "Palantir Technologies"
        },
        {
          "symbol": "MSTR",
          "address": "0xec262a75e413fafd0df80480274532c79d42da09",
          "name": "Strategy Inc."
        },
        {
          "symbol": "SPCX",
          "address": "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
          "name": "Space Exploration Technologies Corp. Class A Common Stock"
        },
        {
          "symbol": "GME",
          "address": "0x1b0e319c6a659f002271b69db8a7df2f911c153e",
          "name": "GameStop"
        },
        {
          "symbol": "GLD",
          "address": "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e",
          "name": "SPDR Gold Trust"
        },
        {
          "symbol": "TTWO",
          "address": "0x5e81213613b6b86eab4c6c50d718d34359459786",
          "name": "Take-Two Interactive Software"
        }
      ]
    },
    {
      "name": "Epic",
      "weight": 180,
      "usd": 50,
      "tokens": [
        {
          "symbol": "COST",
          "address": "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2",
          "name": "Costco"
        },
        {
          "symbol": "ASML",
          "address": "0x47f93d52cbec7c6d2cfc080e154002370a60daea",
          "name": "ASML Holding NV"
        },
        {
          "symbol": "NET",
          "address": "0x116f00968269b7bfbad4109ce591d6e74c0601d4",
          "name": "Cloudflare, Inc. Class A common stock"
        },
        {
          "symbol": "AVGO",
          "address": "0x156e175dd063a8ce274c50654ef40e0032b3fbcf",
          "name": "Broadcom"
        },
        {
          "symbol": "UNH",
          "address": "0xcf364ea52787e289de6f32077834056e3e70d6a8",
          "name": "UnitedHealth"
        }
      ]
    },
    {
      "name": "Legendary",
      "weight": 19,
      "usd": 200,
      "tokens": [
        {
          "symbol": "CELH",
          "address": "0x8cf07c5a878945185d327aaa6e33faa95f95e7bf",
          "name": "Celsius"
        },
        {
          "symbol": "LULU",
          "address": "0x4e62068525ab11fe768e29dfd00ef909b9803016",
          "name": "Lululemon"
        },
        {
          "symbol": "IREN",
          "address": "0xf0ab0c93be6f41369d302e55db1a96b3c430212d",
          "name": "IREN Limited"
        },
        {
          "symbol": "WULF",
          "address": "0x348be1a8663f15edde5cdf8a96bb69078f7ab6fd",
          "name": "TeraWulf"
        },
        {
          "symbol": "GLXY",
          "address": "0x2d427692e928fa156ec22acfabafa0447c5805b7",
          "name": "Galaxy Digital Inc."
        },
        {
          "symbol": "RKLB",
          "address": "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2",
          "name": "Rocket Lab Corporation"
        }
      ]
    },
    {
      "name": "Mythic",
      "weight": 1,
      "usd": 1163,
      "tokens": [
        {
          "symbol": "LLY",
          "address": "0x8005d266423c7ea827372c9c864491e5786600ea",
          "name": "Eli Lilly"
        }
      ]
    }
  ],

  // Company logos, one PNG per ticker symbol.
  logoPath: 'logos/',

  // Where this is served. Printed on the share card and in the link preview.
  siteUrl: 'stonk-packs.vercel.app',

  // Token address -> symbol, for decoding Pull events.
  symbols: {
    "0x25c288e6d899b9bc30160965ad9644c67e73be0c": "F",
    "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b": "AMC",
    "0x48e39e56acdba37b09020c0b734a613c9a2f100a": "BB",
    "0x98e75885157c80992a8d41b696d8c9c6fb30a926": "SOFI",
    "0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b": "RIVN",
    "0xf6589f11bc40b669e584073f428b05562f568733": "SNAP",
    "0x9651342cea770ae9a2969ba2a52611523146aef9": "CCL",
    "0xccee82fe024c36fa15e1005ede3e9e4787e23d09": "HIMS",
    "0x6e3dfd9f7e1649baa14d25cac18c94d62db10a54": "SOUN",
    "0xfde6b5d9bb419b10c23268c74e369abff39c0460": "RCAT",
    "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "AAPL",
    "0xe93237c50d904957cf27e7b1133b510c669c2e74": "MSFT",
    "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": "GOOGL",
    "0x12f190a9f9d7d37a250758b26824b97ce941bf54": "AMZN",
    "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": "META",
    "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "COIN",
    "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": "INTC",
    "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": "AMD",
    "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8": "NFLX",
    "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8": "RBLX",
    "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "NVDA",
    "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "TSLA",
    "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": "PLTR",
    "0xec262a75e413fafd0df80480274532c79d42da09": "MSTR",
    "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": "SPCX",
    "0x1b0e319c6a659f002271b69db8a7df2f911c153e": "GME",
    "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e": "GLD",
    "0x5e81213613b6b86eab4c6c50d718d34359459786": "TTWO",
    "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2": "COST",
    "0x47f93d52cbec7c6d2cfc080e154002370a60daea": "ASML",
    "0x116f00968269b7bfbad4109ce591d6e74c0601d4": "NET",
    "0x156e175dd063a8ce274c50654ef40e0032b3fbcf": "AVGO",
    "0xcf364ea52787e289de6f32077834056e3e70d6a8": "UNH",
    "0x8cf07c5a878945185d327aaa6e33faa95f95e7bf": "CELH",
    "0x4e62068525ab11fe768e29dfd00ef909b9803016": "LULU",
    "0xf0ab0c93be6f41369d302e55db1a96b3c430212d": "IREN",
    "0x348be1a8663f15edde5cdf8a96bb69078f7ab6fd": "WULF",
    "0x2d427692e928fa156ec22acfabafa0447c5805b7": "GLXY",
    "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2": "RKLB",
    "0x8005d266423c7ea827372c9c864491e5786600ea": "LLY",
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG"
  },

  // Approximate USD prices used only to size demo pulls; the contract uses Chainlink.
  demoPrices: {"F":60.86,"AMC":2.59,"BB":7.95,"SOFI":17.73,"RIVN":19.99,"SNAP":22.72,"CCL":36.7,"HIMS":29.27,"SOUN":6.94,"RCAT":14.69,"AAPL":325.81,"MSFT":502.29,"GOOGL":336.22,"AMZN":256.41,"META":580.79,"COIN":177.09,"INTC":89.62,"AMD":454.45,"NFLX":80.42,"RBLX":40.95,"NVDA":218.07,"TSLA":355.99,"PLTR":180.62,"MSTR":126.95,"SPCX":142.09,"GME":18.78,"GLD":398.61,"TTWO":218.21,"COST":944.33,"ASML":1658.72,"NET":284.07,"AVGO":373.39,"UNH":399.8,"CELH":42.58,"LULU":143.63,"IREN":37.26,"WULF":14.93,"GLXY":23.35,"RKLB":62.94,"LLY":1162.57},
};
