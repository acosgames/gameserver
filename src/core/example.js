var action = globals.action();
var state = globals.state();
{
    var newState = Object.assign({}, state);
    newState.dummy = 'hello';
    newState.action = action;
}
globals.finish(newState)