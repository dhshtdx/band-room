import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import nodejs from 'nodejs-mobile-react-native';
import {WebView} from 'react-native-webview';

type ServerMessage = {
  type: 'server-ready' | 'server-error' | 'server-starting';
  port?: number;
  message?: string;
};

let nodeThreadStarted = false;

function App(): React.JSX.Element {
  const webView = useRef<WebView>(null);
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    const onNodeMessage = (raw: unknown) => {
      try {
        const message: ServerMessage =
          typeof raw === 'string' ? JSON.parse(raw) : (raw as ServerMessage);
        if (message.type === 'server-ready' && message.port) {
          setError('');
          setServerPort(message.port);
        } else if (message.type === 'server-error') {
          setError(message.message || '本机服务启动失败。');
        }
      } catch {
        // 忽略来自底层运行时、但不属于 Band Room 的诊断消息。
      }
    };

    nodejs.channel.addListener('message', onNodeMessage);
    if (!nodeThreadStarted) {
      nodeThreadStarted = true;
      nodejs.start('main.cjs', {redirectOutputToLogcat: true});
    }
    // Node 是单例；React Native 页面重载后主动索取一次当前状态。
    nodejs.channel.send(JSON.stringify({type: 'status:request'}));

    return () => nodejs.channel.removeListener('message', onNodeMessage);
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (!canGoBack) {
          return false;
        }
        webView.current?.goBack();
        return true;
      },
    );
    return () => subscription.remove();
  }, [canGoBack]);

  if (error) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor="#111827" />
        <View style={styles.centerCard}>
          <Text style={styles.logo}>BR</Text>
          <Text style={styles.title}>主机服务未启动</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => {
              setError('');
              nodejs.channel.send(JSON.stringify({type: 'status:request'}));
            }}>
            <Text style={styles.buttonText}>重新检查</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!serverPort) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor="#111827" />
        <View style={styles.centerCard}>
          <Text style={styles.logo}>BR</Text>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.title}>正在启动 Band Room</Text>
          <Text style={styles.subtitle}>正在准备曲谱与局域网服务…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.webScreen}>
      <StatusBar barStyle="light-content" backgroundColor="#111827" />
      <WebView
        ref={webView}
        source={{uri: `http://127.0.0.1:${serverPort}/host`}}
        originWhitelist={['http://*', 'https://*']}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        pullToRefreshEnabled={false}
        overScrollMode="never"
        onNavigationStateChange={state => setCanGoBack(state.canGoBack)}
        onError={event =>
          setError(event.nativeEvent.description || '主机页面加载失败。')
        }
        onHttpError={event =>
          setError(`主机页面返回错误：HTTP ${event.nativeEvent.statusCode}`)
        }
        style={styles.webView}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#111827'},
  webScreen: {flex: 1, backgroundColor: '#111827'},
  webView: {flex: 1, backgroundColor: '#111827'},
  centerCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    overflow: 'hidden',
    textAlign: 'center',
    textAlignVertical: 'center',
    backgroundColor: '#38bdf8',
    color: '#082f49',
    fontSize: 30,
    fontWeight: '900',
    marginBottom: 8,
  },
  title: {color: '#f8fafc', fontSize: 22, fontWeight: '700'},
  subtitle: {color: '#94a3b8', fontSize: 15, textAlign: 'center'},
  errorText: {
    color: '#fca5a5',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  button: {
    marginTop: 8,
    minWidth: 150,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 13,
    backgroundColor: '#38bdf8',
  },
  buttonText: {
    color: '#082f49',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
});

export default App;
