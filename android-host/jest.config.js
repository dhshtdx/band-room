module.exports = {
  preset: 'react-native',
  modulePathIgnorePatterns: [
    '<rootDir>/android/app/build/',
    '<rootDir>/nodejs-assets/',
  ],
  moduleNameMapper: {
    '^nodejs-mobile-react-native$':
      '<rootDir>/__mocks__/nodejs-mobile-react-native.js',
    '^react-native-webview$': '<rootDir>/__mocks__/react-native-webview.js',
  },
};
