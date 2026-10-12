const pitchPackageByMethod = {
  torchcrepe: 'torchcrepe==0.0.24',
  rmvpe: 'rmvpe-onnx==0.2.3',
  fcpe: 'torchfcpe==0.0.4',
}

function pitchInstallRequirements(methods) {
  return ['librosa==1.0.0', ...methods.map(method => pitchPackageByMethod[method]).filter(Boolean)]
}

function pitchMethodReady(probe, method, rmvpeModelReady = true) {
  if (!probe?.librosa) return false
  if (method === 'pyin') return true
  if (method === 'torchcrepe') return !!probe.torchcrepe
  if (method === 'rmvpe') return !!probe.rmvpe && rmvpeModelReady
  if (method === 'fcpe') return !!probe.fcpe
  return false
}

function selectedPitchMethodsReady(probe, methods) {
  return methods.every(method => pitchMethodReady(probe, method))
}

module.exports = { pitchInstallRequirements, pitchMethodReady, selectedPitchMethodsReady }
