const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const crypto = require("crypto");
const moment = require("moment-timezone");
require("dotenv").config();
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const multer = require("multer");
const fs = require("fs").promises;
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// R2 클라이언트 설정
const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Multer 설정 수정 - 메모리 스토리지 사용
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB 제한
  },
  fileFilter: function (req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("이미지 파일만 업로드할 수 있습니다."), false);
    }
    cb(null, true);
  },
});

// WebSocket 클라이언트 관리
const clients = new Map();

// 클라이언트 상태 모니터링
const clientStatus = new Map();

// 하트비트 간격 (30초)
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 35000;

// WebSocket 연결 관리
wss.on("connection", async (ws, req) => {
  try {
    ws.isAlive = true;
    ws.lastPing = Date.now();

    // 클라이언트 IP 저장
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress;

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.lastPing = Date.now();
      // 명시적으로 PONG 메시지 전송
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "PONG" }));
      }
    });

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message);

        if (data.type === "REGISTER") {
          // 토큰 검증
          try {
            const decoded = jwt.verify(data.token, process.env.JWT_SECRET);
            const clientId = decoded.id;

            // 기존 연결이 있다면 정리
            const existingConnection = clients.get(clientId);
            if (existingConnection && existingConnection !== ws) {
              existingConnection.close(1000, "새로운 연결로 대체됨");
            }

            clients.set(clientId, ws);
            clientStatus.set(clientId, {
              connectedAt: Date.now(),
              ip,
              lastActivity: Date.now(),
            });

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "CONNECTED",
                  message: "WebSocket 연결이 설정되었습니다.",
                })
              );
            }
          } catch (err) {
            console.error("Token verification error:", err);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "ERROR",
                  message: "인증이 필요합니다.",
                })
              );
              ws.close(1008, "인증 실패");
            }
          }
        } else if (data.type === "HEARTBEAT") {
          ws.isAlive = true;
          ws.lastPing = Date.now();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "PONG" }));
          }
        }
      } catch (error) {
        console.error("Message handling error:", error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "ERROR",
              message: "메시지 처리 중 오류가 발생했습니다.",
            })
          );
        }
      }
    });

    // 연결 종료 처리
    ws.on("close", (code, reason) => {
      console.log(`WebSocket closed: ${code} - ${reason}`);
      for (const [clientId, client] of clients.entries()) {
        if (client === ws) {
          clients.delete(clientId);
          clientStatus.delete(clientId);
          break;
        }
      }
    });

    // 에러 처리
    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
      ws.close(1011, "서버 오류 발생");
    });
  } catch (error) {
    console.error("WebSocket connection error:", error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, "연결 초기화 중 오류 발생");
    }
  }
});

// 하트비트 체크 인터벌
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }

    // 마지막 핑으로부터 시간 체크
    const timeSinceLastPing = Date.now() - ws.lastPing;
    if (timeSinceLastPing > HEARTBEAT_TIMEOUT) {
      return ws.terminate();
    }

    ws.isAlive = false;
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, HEARTBEAT_INTERVAL);

// 브로드캐스트 함수 개선
const broadcastDinnerCheck = async (data) => {
  try {
    // 학생 정보 조회
    const student = await User.findOne({ studentId: data.studentId });
    if (!student) {
      console.error(`Student not found: ${data.studentId}`);
      return;
    }

    // 프로필 이미지 URL은 이미 R2 public URL이므로 추가 처리 불필요
    const profileImageUrl = student.profileImage || null;

    const messageData = {
      type: "DINNER_CHECK",
      timestamp: moment().tz("Asia/Seoul").format("YYYY-MM-DD HH:mm:ss"),
      data: {
        ...data,
        studentName: student.name,
        grade: student.grade,
        class: student.class,
        number: student.number,
        profileImage: profileImageUrl,
        status: data.status || "approved",
      },
    };

    // 디버깅을 위한 로그 추가
    console.log("Broadcasting message with profile image:", profileImageUrl);

    const message = JSON.stringify(messageData);

    for (const [clientId, client] of clients.entries()) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          const status = clientStatus.get(clientId);
          if (status) {
            status.lastActivity = Date.now();
          }
        }
      } catch (error) {
        console.error(`Broadcast error for client ${clientId}:`, error);
        client.terminate();
        clients.delete(clientId);
        clientStatus.delete(clientId);
      }
    }
  } catch (error) {
    console.error("Broadcast error:", error);
  }
};

// 서버 종료 시 정리
process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  wss.close(() => {
    console.log("WebSocket server closed");
  });
});

// trust proxy 설정 추가
app.set("trust proxy", 1);

// Middleware
app.use(cors());
app.use(express.json());

// rate limiter 설정
const limiter = rateLimit({
  windowMs: process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  max: process.env.RATE_LIMIT_MAX_REQUESTS || 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

// rate limiter 적용
app.use(limiter);

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// User model
const UserSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  grade: { type: Number, required: true, enum: [1, 2, 3] },
  class: { type: Number, required: true, min: 1, max: 6 },
  number: { type: Number, required: true, min: 1, max: 100 },
  isAdmin: { type: Boolean, default: false },
  isReader: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
  deviceId: { type: String },
  device: { type: mongoose.Schema.Types.ObjectId, ref: "Device" },
  profileImage: { type: String },
});

const User = mongoose.model("User", UserSchema);

// 석식 체크 스키마
const DinnerCheckSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  timestamp: { type: String, required: true },
  status: {
    type: String,
    enum: ["approved", "denied"],
    required: true,
  },
  mealType: {
    type: String,
    enum: ["dinner"],
    default: "dinner",
  },
  nonce: { type: String, required: true }, // QR 코드 재사용 방지용
  checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

const DinnerCheck = mongoose.model("DinnerCheck", DinnerCheckSchema);

// RefreshToken 모델 추가
const RefreshTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  token: { type: String, required: true },
  expiresAt: {
    type: Date,
    required: true,
    validate: {
      validator: function (v) {
        return v instanceof Date && !isNaN(v);
      },
      message: "유효한 날짜가 아닙니다.",
    },
  },
});

const RefreshToken = mongoose.model("RefreshToken", RefreshTokenSchema);

// 비밀번호 정책 검증 함수
const validatePassword = (password) => {
  return {
    isValid: password.length >= 8,
    requirements: {
      length: password.length >= 8,
    },
  };
};

// 회원가입 라우트
app.post("/api/signup", async (req, res) => {
  try {
    const {
      studentId,
      name,
      password,
      grade,
      class: classNumber,
      number,
    } = req.body;

    // 학번 형식 검증 (4자리 숫자)
    if (!/^\d{4}$/.test(studentId)) {
      return res.status(400).json({ message: "학번은 4자리 숫자여야 합니다." });
    }

    // 이름 형식 검증 (2-4자 한글)
    if (!/^[가-힣]{2,4}$/.test(name)) {
      return res
        .status(400)
        .json({ message: "이름은 2-4자의 한글이어야 합니다." });
    }

    // 비밀번호 길이 검증
    const { isValid } = validatePassword(password);
    if (!isValid) {
      return res.status(400).json({
        message: "비밀번호는 8자 이상이어야 합니다.",
      });
    }

    let user = await User.findOne({ studentId });
    if (user) {
      return res.status(400).json({ message: "이미 존재하는 학번입니다." });
    }

    const gradeNum = Number(grade);
    if (![1, 2, 3].includes(gradeNum)) {
      return res.status(400).json({ message: "유효하지 않은 학년입니다." });
    }

    const classNum = Number(classNumber);
    const numberNum = Number(number);

    if (classNum < 1 || classNum > 6) {
      return res.status(400).json({ message: "유효하지 않은 반입니다." });
    }
    if (numberNum < 1 || numberNum > 100) {
      return res.status(400).json({ message: "유효하지 않은 번호입니다." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({
      studentId,
      name,
      password: hashedPassword,
      grade: gradeNum,
      class: classNum,
      number: numberNum,
    });

    await user.save();

    res.status(201).json({
      message: "회원가입이 완료되었습니다. 관리자의 승인을 기다려주세요.",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 로그인 시도 횟수 관리를 위한 Map
const loginAttempts = new Map();

// 로그인 시도 횟수 체크 미들웨어
const checkLoginAttempts = async (req, res, next) => {
  const ip = req.ip;
  const currentAttempts = loginAttempts.get(ip) || {
    count: 0,
    timestamp: Date.now(),
  };

  // 최대 시도 횟수를 10회로 늘리고, 잠금 시간을 5분으로 설정
  const MAX_ATTEMPTS = process.env.MAX_LOGIN_ATTEMPTS || 50;
  const LOCKOUT_TIME = process.env.LOGIN_LOCKOUT_TIME || 5 * 60 * 1000;

  // 잠금 시간이 지났는지 확인
  if (currentAttempts.count >= MAX_ATTEMPTS) {
    const timeSinceLock = Date.now() - currentAttempts.timestamp;
    if (timeSinceLock < LOCKOUT_TIME) {
      return res.status(429).json({
        success: false,
        message: "너무 많은 로그인 시도. 잠시 후 다시 시도해주세요.",
        remainingTime: Math.ceil((LOCKOUT_TIME - timeSinceLock) / 1000),
      });
    } else {
      // 잠금 시간이 지났으면 초기화
      loginAttempts.delete(ip);
    }
  }

  next();
};

// 로그인 시도 횟수 증가 함수
function incrementLoginAttempts(ip) {
  const MAX_ATTEMPTS = process.env.MAX_LOGIN_ATTEMPTS || 10;
  const currentAttempts = loginAttempts.get(ip) || {
    count: 0,
    timestamp: Date.now(),
  };

  // 최대 시도 횟수에 도달하면 타임스탬프 갱신
  if (currentAttempts.count >= MAX_ATTEMPTS) {
    currentAttempts.timestamp = Date.now();
  } else {
    currentAttempts.count += 1;
  }

  loginAttempts.set(ip, currentAttempts);
}

// 로그인 라우트
app.post("/api/login", checkLoginAttempts, async (req, res) => {
  try {
    const {
      studentId,
      password,
      deviceInfo = null,
      keepLoggedIn = false,
      isWeb = false,
    } = req.body;
    const ip = req.ip;

    // 입력값 검증
    if (!studentId || !password) {
      return res.status(400).json({
        success: false,
        message: "필수 정보가 누락되었습니다.",
      });
    }

    // 사용자 찾기
    const user = await User.findOne({ studentId });
    if (!user) {
      incrementLoginAttempts(ip);
      return res.status(401).json({
        success: false,
        message: "존재하지 않는 학번입니다.",
      });
    }

    // 계정 승인 여부 확인
    if (!user.isApproved) {
      return res.status(403).json({
        success: false,
        message: "아직 승인되지 않은 계정입니다. 관리자의 승인을 기다려주세요.",
      });
    }

    // 비밀번호 확인
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      incrementLoginAttempts(ip);
      return res.status(401).json({
        success: false,
        message: "비밀번호가 일치하지 않습니다.",
      });
    }

    // 웹이 아닌 앱에서 접속한 경우에만 디바이스 확인
    if (!isWeb && deviceInfo && deviceInfo.deviceId) {
      try {
        // 디바이스 ID 디코딩
        const buff = Buffer.from(deviceInfo.deviceId, "base64");
        const decodedDeviceInfo = JSON.parse(buff.toString("utf-8"));

        // 기존 디바이스 확인
        const existingDevice = await Device.findOne({
          deviceId: deviceInfo.deviceId,
          userId: { $ne: user._id },
        });

        if (existingDevice) {
          return res.status(403).json({
            success: false,
            message: "이 기기는 이미 다른 계정에 등록되어 있습니다.",
          });
        }

        // 디바이스 정보 업데이트 또는 생성
        const device = await Device.findOneAndUpdate(
          { userId: user._id },
          {
            deviceId: deviceInfo.deviceId,
            deviceInfo: {
              model: decodedDeviceInfo.model,
              platform: decodedDeviceInfo.osName,
              version: decodedDeviceInfo.osVersion.toString(),
              isEmulator: !decodedDeviceInfo.isDevice,
              lastLogin: new Date(),
            },
          },
          { upsert: true, new: true }
        );

        // User 모델에도 디바이스 정보 연결
        user.deviceId = deviceInfo.deviceId;
        user.device = device._id;
        await user.save();
      } catch (error) {
        console.error("Device info processing error:", error);
      }
    }

    // 로그인 성공 시 시도 횟수 초기화
    loginAttempts.delete(ip);

    // 토큰 생성
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();

    // 리프레시 토큰 저장
    const refreshTokenDoc = new RefreshToken({
      userId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + getRefreshTokenExpiresIn(keepLoggedIn)),
    });

    await RefreshToken.deleteMany({ userId: user._id });
    await refreshTokenDoc.save();

    // 리다이렉트 URL 설정
    const redirectUrl = user.isAdmin || user.isReader ? "hub.html" : "qr.html";

    res.json({
      success: true,
      accessToken,
      refreshToken,
      redirectUrl,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        isAdmin: user.isAdmin,
        isReader: user.isReader,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
    });
  }
});

// JWT Secret 키 확인
if (!process.env.JWT_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  console.error(
    "JWT_SECRET or REFRESH_TOKEN_SECRET is not defined in environment variables"
  );
  process.exit(1);
}

// JWT 토큰 생성 함수
const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      studentId: user.studentId,
      isAdmin: user.isAdmin,
      isReader: user.isReader,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "7d" }
  );
};

// 리프레시 토큰 생성 함수
const generateRefreshToken = () => {
  return crypto.randomBytes(40).toString("hex");
};

// 리프레시 토큰 만료 시간을 로그인 유지 여부에 따라 설정
const getRefreshTokenExpiresIn = (keepLoggedIn) => {
  return keepLoggedIn
    ? parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN) ||
        365 * 24 * 60 * 60 * 1000
    : parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN) ||
        30 * 24 * 60 * 60 * 1000;
};

// 토큰 검증 미들웨어
const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "Authorization 헤더가 없습니다.",
      });
    }

    const [bearer, token] = authHeader.split(" ");
    if (bearer !== "Bearer" || !token || token.trim() === "") {
      return res.status(401).json({
        success: false,
        message: "잘못된 토큰 형식입니다.",
      });
    }

    const cleanToken = token.trim();
    jwt.verify(cleanToken, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        console.error("Token verification error:", err);

        if (err.name === "TokenExpiredError") {
          return res.status(401).json({
            success: false,
            message: "토큰이 만료되었습니다.",
            needRefresh: true,
          });
        }

        return res.status(401).json({
          success: false,
          message: "유효하지 않은 토큰입니다.",
          error: err.message,
        });
      }

      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
      error: error.message,
    });
  }
};

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user.isAdmin) {
      return res.status(403).json({ message: "관리자 권한이 필요합니다." });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
};

// Middleware to check if user is reader
const isReader = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user.isReader && !user.isAdmin) {
      return res.status(403).json({ message: "리더 권한이 필요합니다." });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
};

// QR 코드 생성 API
app.post("/api/generate-qr", verifyToken, async (req, res) => {
  try {
    const { studentId } = req.body;
    const currentUser = await User.findById(req.user.id);

    // 본인 확인
    if (currentUser.studentId !== studentId) {
      return res.status(403).json({
        success: false,
        message: "본인의 QR 코드만 생성할 수 있습니다.",
      });
    }

    // QR 데이터 생성 (30초 유효)
    const timestamp = Date.now();
    const expiresAt = timestamp + 30000; // 30초 후 만료
    const nonce = crypto.randomBytes(16).toString("hex"); // 재사용 방지를 위한 난수

    const qrData = {
      studentId,
      timestamp,
      expiresAt,
      nonce,
    };

    // QR 데이터 암호화
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(process.env.ENCRYPTION_KEY),
      iv
    );

    let encryptedData = cipher.update(JSON.stringify(qrData), "utf8", "base64");
    encryptedData += cipher.final("base64");

    // IV를 암호화된 데이터와 함께 전송
    const qrPayload = {
      data: encryptedData,
      iv: iv.toString("base64"),
      timestamp,
    };

    res.json({
      success: true,
      qrData: JSON.stringify(qrPayload),
    });
  } catch (error) {
    console.error("QR 코드 생성 중 오류:", error);
    res.status(500).json({
      success: false,
      message: "QR 코드 생성 중 오류가 발생했습니다.",
    });
  }
});

// QR 코드 검증 및 석식 체크 API
app.post("/api/dinner/check", verifyToken, isReader, async (req, res) => {
  try {
    const { encryptedQR } = req.body;

    // 입력값 검증
    if (!encryptedQR) {
      console.error("Missing encryptedQR in request body");
      return res.status(400).json({
        success: false,
        message: "QR 코드 데이터가 없습니다.",
      });
    }

    // QR 페이로드 파싱
    let qrPayload;
    try {
      qrPayload = JSON.parse(encryptedQR);
      console.log("Parsed QR payload:", {
        hasData: !!qrPayload.data,
        hasIV: !!qrPayload.iv,
        timestamp: qrPayload.timestamp,
      });
    } catch (parseError) {
      console.error("QR payload parsing error:", parseError);
      return res.status(400).json({
        success: false,
        message: "잘못된 QR 코드 형식입니다.",
      });
    }

    // QR 페이로드 유효성 검사
    if (!qrPayload.data || !qrPayload.iv) {
      console.error("Invalid QR payload structure:", qrPayload);
      return res.status(400).json({
        success: false,
        message: "QR 코드 데이터가 올바르지 않습니다.",
      });
    }

    // 암호화된 데이터 복호화
    let decryptedData;
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-cbc",
        Buffer.from(process.env.ENCRYPTION_KEY),
        Buffer.from(qrPayload.iv, "base64")
      );

      let decrypted = decipher.update(qrPayload.data, "base64", "utf8");
      decrypted += decipher.final("utf8");
      decryptedData = JSON.parse(decrypted);

      console.log("Decrypted QR data:", {
        hasStudentId: !!decryptedData.studentId,
        timestamp: decryptedData.timestamp,
        expiresAt: decryptedData.expiresAt,
        hasNonce: !!decryptedData.nonce,
      });
    } catch (decryptError) {
      console.error("Decryption error:", decryptError);
      return res.status(400).json({
        success: false,
        message: "QR 코드 복호화에 실패했습니다.",
      });
    }

    // QR 코드 유효성 검사
    const currentTime = Date.now();
    if (currentTime > decryptedData.expiresAt) {
      console.log("QR code expired:", {
        currentTime,
        expiresAt: decryptedData.expiresAt,
        difference: currentTime - decryptedData.expiresAt,
      });
      return res.status(400).json({
        success: false,
        message: "만료된 QR 코드입니다.",
      });
    }

    // 이미 사용된 QR 코드인지 확인 (nonce 검사)
    const existingCheck = await DinnerCheck.findOne({
      studentId: decryptedData.studentId,
      nonce: decryptedData.nonce,
    });

    if (existingCheck) {
      console.log("Duplicate QR code usage detected:", {
        studentId: decryptedData.studentId,
        nonce: decryptedData.nonce,
        previousUse: existingCheck.timestamp,
      });
      return res.status(400).json({
        success: false,
        message: "이미 사용된 QR 코드입니다.",
      });
    }

    // 오늘 날짜 범위 설정
    const today = moment().tz("Asia/Seoul");
    const todayStart = today.format("YYYY-MM-DD");
    const todayEnd = today.endOf("day").format("YYYY-MM-DD");

    // 오늘 체크 여부 확인
    const todayCheck = await DinnerCheck.findOne({
      studentId: decryptedData.studentId,
      timestamp: {
        $gte: todayStart,
        $lte: todayEnd,
      },
    });

    if (todayCheck) {
      console.log("Already checked today:", {
        studentId: decryptedData.studentId,
        checkTime: todayCheck.timestamp,
      });
      return res.status(400).json({
        success: false,
        message: "오늘은 이미 체크되었습니다.",
      });
    }

    // 사용자 확인 및 승인 상태 확인
    const student = await User.findOne({ studentId: decryptedData.studentId });
    if (!student) {
      console.error("Student not found:", decryptedData.studentId);
      return res.status(400).json({
        success: false,
        message: "등록되지 않은 학생입니다.",
      });
    }

    if (!student.isApproved) {
      console.log(
        "Unapproved student attempted check:",
        decryptedData.studentId
      );
      return res.status(400).json({
        success: false,
        message: "승인되지 않은 계정입니다.",
      });
    }

    // 새로운 체크 생성
    const newCheck = new DinnerCheck({
      studentId: decryptedData.studentId,
      timestamp: moment().tz("Asia/Seoul").format("YYYY-MM-DD HH:mm:ss"), // 현재 시간을 한국 시간으로 정확히 저장
      status: "approved",
      nonce: decryptedData.nonce,
      checkedBy: req.user.id,
    });

    await newCheck.save();
    console.log("New check created:", {
      studentId: decryptedData.studentId,
      timestamp: newCheck.timestamp,
      checkId: newCheck._id,
    });

    // WebSocket을 통해 실시간 업데이트 전송
    await broadcastDinnerCheck({
      studentId: decryptedData.studentId,
      timestamp: newCheck.timestamp,
      status: "approved",
    });

    res.json({
      success: true,
      message: "석식 체크가 완료되었습니다.",
      check: newCheck,
    });
  } catch (error) {
    console.error("석식 체크 중 오류:", error);
    res.status(500).json({
      success: false,
      message: "석식 체크 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
});

// 한국 시간으로 변환하는 함수
function toKoreanTimeString(date) {
  return moment(date).tz("Asia/Seoul").format("YYYY-MM-DD HH:mm:ss");
}

// 통계 캐시 저장소
const statsCache = {
  data: null,
  lastUpdated: null,
  timeRangeStats: new Map(),
};

// 시간대별 통계 API
app.get("/api/dinner/time-stats", verifyToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const cacheKey = `${startDate}-${endDate}`;

    // 캐시된 데이터 확인
    const cachedStats = statsCache.timeRangeStats.get(cacheKey);
    if (
      cachedStats &&
      Date.now() - cachedStats.timestamp < 5 * 60 * 1000 // 5분 캐시
    ) {
      return res.json({
        success: true,
        stats: cachedStats.data,
        cached: true,
      });
    }

    // 날짜 범위 설정
    const start = startDate
      ? moment(startDate).tz("Asia/Seoul")
      : moment().tz("Asia/Seoul").subtract(30, "days");
    const end = endDate
      ? moment(endDate).tz("Asia/Seoul")
      : moment().tz("Asia/Seoul");

    // 시간대별 통계 계산
    const timeStats = await DinnerCheck.aggregate([
      {
        $match: {
          timestamp: {
            $gte: start.format("YYYY-MM-DD"),
            $lte: end.format("YYYY-MM-DD"),
          },
          status: "approved",
        },
      },
      {
        $addFields: {
          hour: {
            $toInt: {
              $substr: [
                {
                  $arrayElemAt: [{ $split: ["$timestamp", " "] }, 1],
                },
                0,
                2,
              ],
            },
          },
        },
      },
      {
        $group: {
          _id: "$hour",
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // 요일별 통계 계산
    const dayStats = await DinnerCheck.aggregate([
      {
        $match: {
          timestamp: {
            $gte: start.format("YYYY-MM-DD"),
            $lte: end.format("YYYY-MM-DD"),
          },
          status: "approved",
        },
      },
      {
        $addFields: {
          date: { $substr: ["$timestamp", 0, 10] },
        },
      },
      {
        $group: {
          _id: {
            $dayOfWeek: { $dateFromString: { dateString: "$date" } },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // 학년별 시간대 통계
    const gradeTimeStats = await DinnerCheck.aggregate([
      {
        $match: {
          timestamp: {
            $gte: start.format("YYYY-MM-DD"),
            $lte: end.format("YYYY-MM-DD"),
          },
          status: "approved",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "studentId",
          foreignField: "studentId",
          as: "student",
        },
      },
      {
        $unwind: "$student",
      },
      {
        $addFields: {
          hour: {
            $toInt: {
              $substr: [
                {
                  $arrayElemAt: [{ $split: ["$timestamp", " "] }, 1],
                },
                0,
                2,
              ],
            },
          },
        },
      },
      {
        $group: {
          _id: {
            grade: "$student.grade",
            hour: "$hour",
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.grade": 1, "_id.hour": 1 },
      },
    ]);

    const stats = {
      timeDistribution: timeStats.map((stat) => ({
        hour: stat._id,
        count: stat.count,
      })),
      dayDistribution: dayStats.map((stat) => ({
        day: stat._id,
        count: stat.count,
      })),
      gradeTimeDistribution: gradeTimeStats.map((stat) => ({
        grade: stat._id.grade,
        hour: stat._id.hour,
        count: stat.count,
      })),
      period: {
        start: start.format("YYYY-MM-DD"),
        end: end.format("YYYY-MM-DD"),
      },
    };

    // 통계 캐시 저장
    statsCache.timeRangeStats.set(cacheKey, {
      timestamp: Date.now(),
      data: stats,
    });

    res.json({
      success: true,
      stats,
      cached: false,
    });
  } catch (error) {
    console.error("시간대별 통계 조회 중 오류:", error);
    res.status(500).json({
      success: false,
      message: "시간대별 통계 조회 중 오류가 발생했습니다.",
    });
  }
});

// 로그아웃 라우트
app.post("/api/logout", verifyToken, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    await RefreshToken.deleteOne({ token: refreshToken });
    res.json({ success: true, message: "로그아웃되었습니다." });
  } catch (error) {
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 비밀번호 변경 라우트
app.post("/api/change-password", verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(400).json({ message: "사용자를 찾을 수 없습니다." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ message: "현재 비밀번호가 일치하지 않습니다." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    await user.save();

    res.json({ message: "비밀번호가 성공적으로 변경되었습니다." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 리프레시 토큰 엔드포인트
app.post("/api/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: "리프레시 토큰이 필요합니다.",
      });
    }

    // 리프레시 토큰 검증
    const refreshTokenDoc = await RefreshToken.findOne({
      token: refreshToken,
      expiresAt: { $gt: new Date() },
    });

    if (!refreshTokenDoc) {
      return res.status(401).json({
        success: false,
        message: "유효하지 않거나 만료된 리프레시 토큰입니다.",
        needRelogin: true,
      });
    }

    // 사용자 정보 조회
    const user = await User.findById(refreshTokenDoc.userId);
    if (!user) {
      await RefreshToken.deleteOne({ _id: refreshTokenDoc._id });
      return res.status(401).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
        needRelogin: true,
      });
    }

    // 새로운 액세스 토큰 생성
    const accessToken = generateAccessToken(user);

    // 새로운 리프레시 토큰 생성
    const newRefreshToken = generateRefreshToken();

    // 기존 리프레시 토큰 업데이트
    await RefreshToken.findByIdAndUpdate(refreshTokenDoc._id, {
      token: newRefreshToken,
      expiresAt: new Date(Date.now() + getRefreshTokenExpiresIn(false)),
    });

    res.json({
      success: true,
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        isAdmin: user.isAdmin,
        isReader: user.isReader,
      },
    });
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(500).json({
      success: false,
      message: "토큰 갱신 중 오류가 발생했습니다.",
    });
  }
});

// 사용자 정보 조회 API 수정
app.get("/api/student-info", verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json({
      success: true,
      studentId: user.studentId,
      name: user.name,
      isAdmin: user.isAdmin,
      isReader: user.isReader,
      grade: user.grade,
      class: user.class,
      number: user.number,
      profileImage: user.profileImage, // 이미 R2 public URL이므로 그대로 사용
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
    });
  }
});

// 관리자용 사용자 목록 조회 API 수정
app.get("/api/admin/users", verifyToken, isAdmin, async (req, res) => {
  try {
    const { grade, class: classNumber } = req.query;
    let query = {};
    if (grade) query.grade = Number(grade);
    if (classNumber) query.class = Number(classNumber);

    const users = await User.find(query).select("-password");
    // profileImage는 이미 R2 public URL이므로 추가 처리 불필요
    res.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 관리자용 승인 대기 사용자 목록 조회 API
app.get("/api/admin/pending-users", verifyToken, isAdmin, async (req, res) => {
  try {
    const pendingUsers = await User.find({ isApproved: false });
    res.json(pendingUsers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 관리자용 사용자 승인 API
app.post("/api/admin/approve-user", verifyToken, isAdmin, async (req, res) => {
  try {
    const { userId, isApproved } = req.body;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }
    user.isApproved = isApproved;
    await user.save();
    res.json({ message: "사용자 승인 상태가 업데이트되었습니다." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 관리자용 관리자 권한 설정 API
app.post("/api/admin/set-admin", verifyToken, isAdmin, async (req, res) => {
  try {
    const { userId, isAdmin } = req.body;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }
    user.isAdmin = isAdmin;
    await user.save();
    res.json({ message: "사용자의 관리자 권한이 변경되었습니다." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 관리자용 리더 권한 설정 API
app.post("/api/admin/set-reader", verifyToken, isAdmin, async (req, res) => {
  try {
    const { userId, isReader } = req.body;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }
    user.isReader = isReader;
    await user.save();
    res.json({ message: "사용자의 리더 권한이 변경되었습니다." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 관리자용 사용자 삭제 API
app.delete(
  "/api/admin/users/:userId",
  verifyToken,
  isAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      await User.findByIdAndDelete(userId);
      res.json({ message: "사용자가 삭제되었습니다." });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "서버 오류가 발생했습니다." });
    }
  }
);

// 관리자용 비밀번호 초기화 API
app.post(
  "/api/admin/reset-password",
  verifyToken,
  isAdmin,
  async (req, res) => {
    try {
      const { userId } = req.body;
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      // 8자리 난수 생성 (숫자 + 영문자)
      const randomPassword = Array.from(crypto.randomBytes(4))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(randomPassword, salt);
      user.password = hashedPassword;
      await user.save();

      res.json({
        message: "비밀번호가 초기화되었습니다.",
        newPassword: randomPassword,
      });
    } catch (error) {
      console.error("비밀번호 초기화 중 오류 발생:", error);
      res.status(500).json({ message: "서버 오류가 발생했습니다." });
    }
  }
);

// 단일 사용자 정보 조회 API 수정
app.get("/api/admin/users/:userId", verifyToken, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId)
      .select("-password")
      .populate("device");

    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    const device = await Device.findOne({ userId: user._id });
    const responseData = {
      ...user.toObject(),
      deviceInfo: device ? device.deviceInfo : null,
      deviceId: device ? device.deviceId : null,
      // profileImage는 이미 R2 public URL이므로 추가 처리 불필요
    };

    res.json(responseData);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

// 체크 이력 API
app.get("/api/dinner/history", verifyToken, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      studentId,
      status,
      page = 1,
      limit = 20,
    } = req.query;
    const skip = (page - 1) * limit;

    // 현재 사용자 정보 조회
    const currentUser = await User.findById(req.user.id);

    // 권한 확인 (관리자이거나 본인 기록만 조회 가능)
    let userQueryCondition = {};
    if (!currentUser.isAdmin) {
      if (!studentId || studentId !== currentUser.studentId) {
        userQueryCondition = { studentId: currentUser.studentId };
      }
    }

    // 쿼리 조건 설정
    const queryCondition = { ...userQueryCondition };

    // 날짜 범위 설정
    if (startDate || endDate) {
      queryCondition.timestamp = {};
      if (startDate) {
        queryCondition.timestamp.$gte = moment(startDate)
          .tz("Asia/Seoul")
          .startOf("day")
          .format("YYYY-MM-DD HH:mm:ss");
      }
      if (endDate) {
        queryCondition.timestamp.$lte = moment(endDate)
          .tz("Asia/Seoul")
          .endOf("day")
          .format("YYYY-MM-DD HH:mm:ss");
      }
    }

    // 학생 ID 필터
    if (studentId) {
      queryCondition.studentId = studentId;
    }

    // 상태 필터
    if (status && ["approved", "denied"].includes(status)) {
      queryCondition.status = status;
    }

    // 전체 기록 수 조회
    const totalCount = await DinnerCheck.countDocuments(queryCondition);

    // 페이지네이션된 기록 조회
    const checks = await DinnerCheck.find(queryCondition)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("checkedBy", "name");

    // 전체 급식일 수 계산 (승인된 체크가 있는 날짜 수)
    const totalDays = await DinnerCheck.distinct("timestamp", {
      status: "approved",
      ...(queryCondition.timestamp
        ? { timestamp: queryCondition.timestamp }
        : {}),
    }).then((dates) => new Set(dates.map((d) => d.substring(0, 10))).size);

    // 모든 학생 정보 조회 (관리자 제외)
    const allStudents = await User.find(
      { isAdmin: { $ne: true } },
      "studentId name grade class number"
    ).lean();

    // 각 학생별 체크 통계 계산
    const checkStats = await DinnerCheck.aggregate([
      {
        $match: {
          ...(queryCondition.timestamp
            ? { timestamp: queryCondition.timestamp }
            : {}),
        },
      },
      {
        $group: {
          _id: "$studentId",
          totalChecks: { $sum: 1 },
          approvedChecks: {
            $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
          },
          lastCheckDate: { $max: "$timestamp" },
          checkDates: { $addToSet: { $substr: ["$timestamp", 0, 10] } },
        },
      },
    ]);

    // 학생 정보와 체크 통계 매핑
    const usersWithStats = allStudents.map((student) => {
      const stats = checkStats.find(
        (stat) => stat._id === student.studentId
      ) || {
        totalChecks: 0,
        approvedChecks: 0,
        lastCheckDate: null,
        checkDates: [],
      };

      return {
        ...student,
        totalChecks: stats.totalChecks,
        approvedChecks: stats.approvedChecks,
        lastCheckDate: stats.lastCheckDate,
        attendanceRate:
          totalDays > 0
            ? ((stats.checkDates.length / totalDays) * 100).toFixed(1)
            : "0.0",
      };
    });

    // 응답 데이터 구성
    const history = checks.map((check) => {
      const student = allStudents.find((s) => s.studentId === check.studentId);
      return {
        id: check._id,
        studentId: check.studentId,
        studentName: student?.name || "Unknown",
        grade: student?.grade,
        class: student?.class,
        number: student?.number,
        status: check.status,
        timestamp: check.timestamp,
        checkedBy: check.checkedBy?.name || "Unknown",
      };
    });

    res.json({
      success: true,
      history,
      users: usersWithStats.sort((a, b) => {
        if (a.grade !== b.grade) return a.grade - b.grade;
        if (a.class !== b.class) return a.class - b.class;
        return a.number - b.number;
      }),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / limit),
        totalRecords: totalCount,
        limit: parseInt(limit),
      },
      summary: {
        totalDays,
        totalChecks: await DinnerCheck.countDocuments({
          status: "approved",
          ...(queryCondition.timestamp
            ? { timestamp: queryCondition.timestamp }
            : {}),
        }),
        uniqueStudents: usersWithStats.filter((u) => u.totalChecks > 0).length,
      },
    });
  } catch (error) {
    console.error("체크 이력 조회 중 오류:", error);
    res.status(500).json({
      success: false,
      message: "체크 이력 조회 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
});

// 석식 체크 취소 API
app.post("/api/dinner/cancel", verifyToken, isReader, async (req, res) => {
  try {
    const { checkId } = req.body;

    // 체크 기록 조회
    const check = await DinnerCheck.findById(checkId);
    if (!check) {
      return res.status(404).json({
        success: false,
        message: "해당하는 체크 기록을 찾을 수 없습니다.",
      });
    }

    // 당일 취소만 가능하도록 제한
    const checkDate = moment(check.timestamp).tz("Asia/Seoul");
    const now = moment().tz("Asia/Seoul");
    if (!checkDate.isSame(now, "day")) {
      return res.status(400).json({
        success: false,
        message: "당일 체크된 기록만 취소할 수 있습니다.",
      });
    }

    // 체크 기록 삭제
    await DinnerCheck.findByIdAndDelete(checkId);

    // WebSocket을 통해 취소 알림
    broadcastDinnerCheck({
      type: "CHECK_CANCELED",
      data: {
        checkId,
        studentId: check.studentId,
        timestamp: check.timestamp,
      },
    });

    res.json({
      success: true,
      message: "석식 체크가 취소되었습니다.",
    });
  } catch (error) {
    console.error("석식 체크 취소 중 오류:", error);
    res.status(500).json({
      success: false,
      message: "석식 체크 취소 중 오류가 발생했습니다.",
    });
  }
});

// 석식 체크 상태 수정 API (관리자용)
app.put(
  "/api/dinner/check/:checkId",
  verifyToken,
  isAdmin,
  async (req, res) => {
    try {
      const { checkId } = req.params;
      const { status } = req.body;

      if (!["approved", "denied"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "유효하지 않은 상태값입니다.",
        });
      }

      const check = await DinnerCheck.findById(checkId);
      if (!check) {
        return res.status(404).json({
          success: false,
          message: "해당하는 체크 기록을 찾을 수 없습니다.",
        });
      }

      // 상태 업데이트
      check.status = status;
      await check.save();

      // WebSocket을 통해 상태 변경 알림
      broadcastDinnerCheck({
        type: "CHECK_UPDATED",
        data: {
          checkId,
          studentId: check.studentId,
          timestamp: check.timestamp,
          status: check.status,
        },
      });

      res.json({
        success: true,
        message: "석식 체크 상태가 수정되었습니다.",
        check,
      });
    } catch (error) {
      console.error("석식 체크 수정 중 오류:", error);
      res.status(500).json({
        success: false,
        message: "석식 체크 수정 중 오류가 발생했습니다.",
      });
    }
  }
);

// R2에 파일 업로드하는 함수
async function uploadToR2(file, userId) {
  try {
    const fileExtension = path.extname(file.originalname);
    const key = `profiles/${userId}-${Date.now()}${fileExtension}`;

    const upload = new Upload({
      client: r2Client,
      params: {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      },
    });

    await upload.done();
    return `${process.env.R2_PUBLIC_URL}/${key}`;
  } catch (error) {
    console.error("R2 업로드 오류:", error);
    throw new Error("파일 업로드 중 오류가 발생했습니다.");
  }
}

// R2에서 파일 삭제하는 함수
async function deleteFromR2(imageUrl) {
  try {
    if (!imageUrl) return;

    const key = imageUrl.replace(process.env.R2_PUBLIC_URL + "/", "");

    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
      })
    );
  } catch (error) {
    console.error("R2 삭제 오류:", error);
    throw new Error("파일 삭제 중 오류가 발생했습니다.");
  }
}

// 프로필 이미지 업로드 API 수정
app.post(
  "/api/admin/users/:userId/profile-image",
  verifyToken,
  isAdmin,
  upload.single("profileImage"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "이미지 파일이 필요합니다." });
      }

      const user = await User.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      // 기존 프로필 이미지가 있다면 R2에서 삭제
      if (user.profileImage) {
        await deleteFromR2(user.profileImage);
      }

      // 새 이미지를 R2에 업로드
      const imageUrl = await uploadToR2(req.file, user._id);

      // 사용자 프로필 이미지 URL 업데이트
      user.profileImage = imageUrl;
      await user.save();

      res.json({
        success: true,
        message: "프로필 이미지가 업로드되었습니다.",
        profileImage: imageUrl,
      });
    } catch (error) {
      console.error("프로필 이미지 업로드 오류:", error);
      res.status(500).json({
        message: "프로필 이미지 업로드 중 오류가 발생했습니다.",
        error: error.message,
      });
    }
  }
);

// 프로필 이미지 삭제 API 수정
app.delete(
  "/api/admin/users/:userId/profile-image",
  verifyToken,
  isAdmin,
  async (req, res) => {
    try {
      const user = await User.findById(req.params.userId);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      if (user.profileImage) {
        await deleteFromR2(user.profileImage);
        user.profileImage = undefined;
        await user.save();
      }

      res.json({ message: "프로필 이미지가 삭제되었습니다." });
    } catch (error) {
      console.error("프로필 이미지 삭제 오류:", error);
      res.status(500).json({
        message: "프로필 이미지 삭제 중 오류가 발생했습니다.",
        error: error.message,
      });
    }
  }
);

// 통계 API 엔드포인트
app.get("/api/dinner/stats", verifyToken, async (req, res) => {
  try {
    const today = moment().tz("Asia/Seoul");
    const todayStr = today.format("YYYY-MM-DD");
    const thisMonth = today.format("YYYY-MM");

    // 전체 통계
    const overallStats = await DinnerCheck.aggregate([
      {
        $match: {
          status: "approved",
        },
      },
      {
        $group: {
          _id: null,
          totalDays: { $addToSet: { $substr: ["$timestamp", 0, 10] } },
          totalChecks: { $sum: 1 },
        },
      },
    ]);

    // 오늘의 통계
    const todayStats = await DinnerCheck.aggregate([
      {
        $match: {
          timestamp: {
            $gte: todayStr,
            $lt: today.add(1, "day").format("YYYY-MM-DD"),
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          approved: {
            $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
          },
        },
      },
    ]);

    // 이번 달 일별 통계
    const dailyStats = await DinnerCheck.aggregate([
      {
        $match: {
          status: "approved",
          timestamp: {
            $regex: `^${thisMonth}`,
          },
        },
      },
      {
        $group: {
          _id: { $substr: ["$timestamp", 0, 10] },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // 사용자별 통계
    const userStats = await DinnerCheck.aggregate([
      {
        $match: {
          status: "approved",
        },
      },
      {
        $group: {
          _id: "$studentId",
          totalChecks: { $sum: 1 },
          checkDates: { $addToSet: { $substr: ["$timestamp", 0, 10] } },
          lastCheckDate: { $max: "$timestamp" },
          thisMonthChecks: {
            $sum: {
              $cond: [
                {
                  $regexMatch: { input: "$timestamp", regex: `^${thisMonth}` },
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    // 사용자 정보 조회
    const studentIds = userStats.map((stat) => stat._id);
    const users = await User.find(
      { studentId: { $in: studentIds } },
      "studentId name grade class number"
    ).lean();

    // 사용자 통계 매핑
    const userStatsWithInfo = userStats.map((stat) => {
      const user = users.find((u) => u.studentId === stat._id);
      return {
        studentId: stat._id,
        name: user?.name || "알 수 없음",
        grade: user?.grade,
        class: user?.class,
        number: user?.number,
        totalChecks: stat.totalChecks,
        thisMonthChecks: stat.thisMonthChecks,
        lastCheckDate: stat.lastCheckDate,
        attendanceRate: (
          (stat.checkDates.length / overallStats[0].totalDays.length) *
          100
        ).toFixed(1),
      };
    });

    // 결식자 통계 (오늘)
    const absentToday = await User.find(
      {
        studentId: {
          $nin: await DinnerCheck.distinct("studentId", {
            timestamp: {
              $gte: todayStr,
              $lt: today.add(1, "day").format("YYYY-MM-DD"),
            },
            status: "approved",
          }),
        },
        isAdmin: { $ne: true }, // 관리자 제외
      },
      "studentId name grade class number"
    ).lean();

    res.json({
      overall: {
        totalDays: overallStats[0]?.totalDays.length || 0,
        totalChecks: overallStats[0]?.totalChecks || 0,
        averageChecksPerDay: overallStats[0]
          ? (
              overallStats[0].totalChecks / overallStats[0].totalDays.length
            ).toFixed(1)
          : 0,
      },
      today: {
        date: todayStr,
        total: todayStats[0]?.total || 0,
        approved: todayStats[0]?.approved || 0,
        absent: absentToday,
      },
      thisMonth: {
        month: thisMonth,
        dailyStats: dailyStats,
        totalDays: dailyStats.length,
        totalChecks: dailyStats.reduce((sum, day) => sum + day.count, 0),
      },
      users: userStatsWithInfo.sort((a, b) => {
        if (a.grade !== b.grade) return a.grade - b.grade;
        if (a.class !== b.class) return a.class - b.class;
        return a.number - b.number;
      }),
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ message: "통계를 가져오는데 실패했습니다." });
  }
});

// 사용자별 상세 통계 API
app.get("/api/dinner/user-stats/:studentId", verifyToken, async (req, res) => {
  try {
    const { studentId } = req.params;
    const user = await User.findOne({ studentId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 전체 급식일 수 계산 (활성화된 급식일만)
    const allChecks = await DinnerCheck.distinct("timestamp", {
      status: "approved",
    });
    const uniqueDates = new Set(allChecks.map((date) => date.substring(0, 10)));
    let totalDays = 0;

    for (const date of uniqueDates) {
      if (await isDinnerDate(date)) {
        totalDays++;
      }
    }

    // 승인된 체크 수 계산
    const approvedChecks = await DinnerCheck.countDocuments({
      studentId,
      status: "approved",
    });

    // 최근 체크 기록 조회 (최근 30개)
    const recentChecks = await DinnerCheck.find({ studentId })
      .sort({ timestamp: -1 })
      .limit(30);

    res.json({
      success: true,
      user: {
        studentId: user.studentId,
        name: user.name,
        grade: user.grade,
        class: user.class,
        number: user.number,
      },
      summary: {
        totalDays,
        approvedChecks,
      },
      recentChecks: recentChecks.map((check) => ({
        timestamp: check.timestamp,
        status: check.status,
      })),
    });
  } catch (error) {
    console.error("사용자 통계 조회 중 오류:", error);
    res.status(500).json({
      success: false,
      message: "사용자 통계 조회 중 오류가 발생했습니다.",
    });
  }
});

// 학생별 상세 통계 API
app.get(
  "/api/dinner/student-detail/:studentId",
  verifyToken,
  async (req, res) => {
    try {
      const { studentId } = req.params;
      const { startDate, endDate } = req.query;

      // 날짜 범위 설정
      const dateQuery = {};
      if (startDate || endDate) {
        dateQuery.timestamp = {};
        if (startDate) {
          dateQuery.timestamp.$gte = startDate;
        }
        if (endDate) {
          dateQuery.timestamp.$lte = moment(endDate)
            .endOf("day")
            .format("YYYY-MM-DD HH:mm:ss");
        }
      }

      // 학생 정보 조회
      const student = await User.findOne(
        { studentId },
        "studentId name grade class number"
      ).lean();
      if (!student) {
        return res.status(404).json({ message: "학생을 찾을 수 없습니다." });
      }

      // 전체 급식일 조회
      const allDays = await DinnerCheck.distinct("timestamp", {
        status: "approved",
        ...dateQuery,
      }).then((dates) => dates.map((d) => d.substring(0, 10)).sort());

      // 학생의 체크 기록 조회
      const checks = await DinnerCheck.find({
        studentId,
        ...dateQuery,
      }).sort({ timestamp: 1 });

      // 날짜별 상태 매핑
      const dateStatus = new Map();
      allDays.forEach((date) => {
        dateStatus.set(date, { status: "absent", check: null });
      });

      checks.forEach((check) => {
        const date = check.timestamp.substring(0, 10);
        if (dateStatus.has(date)) {
          dateStatus.set(date, {
            status: check.status,
            check,
          });
        }
      });

      // 통계 계산
      const stats = {
        totalDays: allDays.length,
        approved: checks.filter((c) => c.status === "approved").length,
        denied: checks.filter((c) => c.status === "denied").length,
        absent:
          allDays.length - checks.filter((c) => c.status === "approved").length,
        details: Array.from(dateStatus.entries()).map(([date, data]) => ({
          date,
          status: data.status,
          checkedAt: data.check
            ? moment(data.check.timestamp).format("HH:mm:ss")
            : null,
          checkedBy: data.check?.checkedBy?.name || null,
        })),
      };

      res.json({
        success: true,
        student,
        stats,
      });
    } catch (error) {
      console.error("학생 상세 통계 조회 중 오류:", error);
      res.status(500).json({
        success: false,
        message: "학생 상세 통계 조회 중 오류가 발생했습니다.",
      });
    }
  }
);

// 관리자용 사용자 추가 API
app.post("/api/admin/users", verifyToken, isAdmin, async (req, res) => {
  try {
    const {
      studentId,
      name,
      password,
      grade,
      class: classNumber,
      number,
      isApproved,
    } = req.body;

    // 학번 형식 검증 (4자리 숫자)
    if (!/^\d{4}$/.test(studentId)) {
      return res.status(400).json({ message: "학번은 4자리 숫자여야 합니다." });
    }

    // 이름 형식 검증 (2-4자 한글)
    if (!/^[가-힣]{2,4}$/.test(name)) {
      return res
        .status(400)
        .json({ message: "이름은 2-4자의 한글이어야 합니다." });
    }

    // 학년, 반, 번호 검증
    if (![1, 2, 3].includes(grade)) {
      return res.status(400).json({ message: "유효하지 않은 학년입니다." });
    }
    if (classNumber < 1 || classNumber > 6) {
      return res.status(400).json({ message: "유효하지 않은 반입니다." });
    }
    if (number < 1 || number > 100) {
      return res.status(400).json({ message: "유효하지 않은 번호입니다." });
    }

    // 기존 사용자 확인
    let existingUser = await User.findOne({ studentId });
    if (existingUser) {
      return res.status(400).json({ message: "이미 존재하는 학번입니다." });
    }

    // 비밀번호 해싱
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 새 사용자 생성
    const user = new User({
      studentId,
      name,
      password: hashedPassword,
      grade,
      class: classNumber,
      number,
      isApproved: isApproved || false,
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: "사용자가 추가되었습니다.",
      user: {
        id: user._id,
        studentId: user.studentId,
        name: user.name,
        grade: user.grade,
        class: user.class,
        number: user.number,
        isApproved: user.isApproved,
      },
    });
  } catch (error) {
    console.error("사용자 추가 오류:", error);
    res.status(500).json({
      success: false,
      message: "사용자 추가 중 오류가 발생했습니다.",
    });
  }
});

// 급식일 관리 모델 수정
const DinnerDateSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // YYYY-MM-DD 형식
  startTime: { type: Date, required: true }, // 급식 시작 시간
  endTime: { type: Date }, // 급식 종료 시간 (null이면 진행중)
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

const DinnerDate = mongoose.model("DinnerDate", DinnerDateSchema);

// 급식일 목록 조회 API
app.get("/api/dinner/dates", verifyToken, isAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const query = {};

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    const dates = await DinnerDate.find(query)
      .sort({ date: -1 })
      .populate("updatedBy", "name");

    res.json({ success: true, dates });
  } catch (error) {
    console.error("급식일 목록 조회 중 오류:", error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
});

// 급식일 상태 변경 API
app.post(
  "/api/dinner/dates/:date/toggle",
  verifyToken,
  isAdmin,
  async (req, res) => {
    try {
      const { date } = req.params;
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

      if (!dateRegex.test(date)) {
        return res
          .status(400)
          .json({ success: false, message: "올바른 날짜 형식이 아닙니다." });
      }

      let dinnerDate = await DinnerDate.findOne({ date });

      if (dinnerDate) {
        dinnerDate.isActive = !dinnerDate.isActive;
        dinnerDate.updatedAt = new Date();
        dinnerDate.updatedBy = req.user.id;
      } else {
        dinnerDate = new DinnerDate({
          date,
          isActive: true,
          updatedBy: req.user.id,
        });
      }

      await dinnerDate.save();
      res.json({
        success: true,
        message: `${date} 급식일이 ${
          dinnerDate.isActive ? "활성화" : "비활성화"
        }되었습니다.`,
        date: dinnerDate,
      });
    } catch (error) {
      console.error("급식일 상태 변경 중 오류:", error);
      res
        .status(500)
        .json({ success: false, message: "서버 오류가 발생했습니다." });
    }
  }
);

// 급식일 여부 확인 함수 수정
async function isDinnerDate(date) {
  const dinnerDate = await DinnerDate.findOne({ date });
  return dinnerDate && !dinnerDate.endTime; // 시작되고 아직 종료되지 않은 상태만 true
}

// 오늘의 급식 상태 조회 API
app.get("/api/dinner/today-status", verifyToken, async (req, res) => {
  try {
    const today = moment().tz("Asia/Seoul").format("YYYY-MM-DD");
    const dinnerDate = await DinnerDate.findOne({ date: today })
      .populate("createdBy", "name")
      .populate("endedBy", "name");

    res.json({
      success: true,
      isActive: dinnerDate && !dinnerDate.endTime,
      dinnerDate,
    });
  } catch (error) {
    console.error("급식 상태 조회 중 오류:", error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
});

// 급식 시작 API
app.post("/api/dinner/start", verifyToken, isReader, async (req, res) => {
  try {
    const today = moment().tz("Asia/Seoul");
    const todayStr = today.format("YYYY-MM-DD");

    // 이미 시작된 급식이 있는지 확인
    let dinnerDate = await DinnerDate.findOne({ date: todayStr });
    if (dinnerDate && !dinnerDate.endTime) {
      return res.status(400).json({
        success: false,
        message: "이미 급식이 시작되었습니다.",
      });
    }

    // 새로운 급식 시작
    dinnerDate = new DinnerDate({
      date: todayStr,
      startTime: new Date(),
      createdBy: req.user.id,
    });

    await dinnerDate.save();

    // WebSocket으로 상태 변경 알림
    broadcastDinnerStatus({
      type: "DINNER_STARTED",
      date: todayStr,
      startTime: dinnerDate.startTime,
    });

    res.json({
      success: true,
      message: "급식이 시작되었습니다.",
      dinnerDate,
    });
  } catch (error) {
    console.error("급식 시작 중 오류:", error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
});

// 급식 종료 API
app.post("/api/dinner/end", verifyToken, isReader, async (req, res) => {
  try {
    const today = moment().tz("Asia/Seoul").format("YYYY-MM-DD");

    const dinnerDate = await DinnerDate.findOne({ date: today, endTime: null });
    if (!dinnerDate) {
      return res.status(400).json({
        success: false,
        message: "진행 중인 급식이 없습니다.",
      });
    }

    dinnerDate.endTime = new Date();
    dinnerDate.endedBy = req.user.id;
    await dinnerDate.save();

    // WebSocket으로 상태 변경 알림
    broadcastDinnerStatus({
      type: "DINNER_ENDED",
      date: today,
      endTime: dinnerDate.endTime,
    });

    res.json({
      success: true,
      message: "급식이 종료되었습니다.",
      dinnerDate,
    });
  } catch (error) {
    console.error("급식 종료 중 오류:", error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
});

// 급식 상태 변경 브로드캐스트 함수
function broadcastDinnerStatus(data) {
  for (const [, client] of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
