// Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)의 값입니다.
// 이 값은 비밀번호가 아니라 공개되어도 됩니다. 보안은 firestore.rules가 책임집니다.
export const firebaseConfig = {
  apiKey: "AIzaSyCgKN6MkX5IIJMhfFugSDLwGt010-gl-Nc",
  authDomain: "field-trip-e5c30.firebaseapp.com",
  projectId: "field-trip-e5c30",
  storageBucket: "field-trip-e5c30.firebasestorage.app",
  messagingSenderId: "831512753931",
  appId: "1:831512753931:web:8fcd3610c46307d699d40e",
};

// 담임이 신청서/결과보고서를 승인·반려할 때 학생에게 메일을 보내는 Google Apps Script 웹 앱 주소.
// mail-sender/README.md 순서대로 배포한 뒤 "웹 앱 URL"을 여기에 넣으세요. 비워 두면 메일을 보내지 않습니다.
export const mailEndpoint = "";
